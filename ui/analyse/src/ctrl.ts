import { opposite } from 'draughtsground/util';
import { countGhosts } from 'draughtsground/fen';
import { Api as DraughtsgroundApi } from 'draughtsground/api';
import { DrawShape } from 'draughtsground/draw';
import * as cg from 'draughtsground/types';
import { Config as DraughtsgroundConfig } from 'draughtsground/config';
import { build as makeTree, path as treePath, ops as treeOps, TreeWrapper } from 'tree';
import * as keyboard from './keyboard';
import { Ctrl as ActionMenuCtrl } from './actionMenu';
import { Autoplay, AutoplayDelay } from './autoplay';
import * as util from './util';
import * as draughtsUtil from 'draughts';
import { storedProp, throttle, defined, prop, Prop, StoredBooleanProp } from 'common';
import { make as makeSocket, Socket } from './socket';
import { ForecastCtrl } from './forecast/interfaces';
import { make as makeForecast } from './forecast/forecastCtrl';
import { ctrl as cevalCtrl, isEvalBetter, CevalCtrl, Work as CevalWork, CevalOpts } from 'ceval';
import explorerCtrl from './explorer/explorerCtrl';
import { ExplorerCtrl } from './explorer/interfaces';
import { game, GameData } from 'game';
import { valid as crazyValid } from './crazy/crazyCtrl';
import makeStudy from './study/studyCtrl';
import { StudyCtrl } from './study/interfaces';
import { StudyPracticeCtrl } from './study/practice/interfaces';
import { make as makeFork, ForkCtrl } from './fork';
import { make as makeRetro, RetroCtrl } from './retrospect/retroCtrl';
import { make as makePractice, PracticeCtrl } from './practice/practiceCtrl';
import { make as makeEvalCache, EvalCache } from './evalCache';
import { compute as computeAutoShapes } from './autoShape';
import { getCompChild, nextGlyphSymbol } from './nodeFinder';
import { AnalyseOpts, AnalyseData, ServerEvalData, Key, CgDests, JustCaptured } from './interfaces';
import GamebookPlayCtrl from './study/gamebook/gamebookPlayCtrl';
import { calcDests } from './study/gamebook/gamebookEmbed';
import { ctrl as treeViewCtrl, TreeView } from './treeView/treeView';

const li = window.lidraughts;

export default class AnalyseCtrl {

  opts: AnalyseOpts;
  data: AnalyseData;
  element: HTMLElement;
  redraw: () => void;

  tree: TreeWrapper;
  socket: Socket;
  draughtsground: DraughtsgroundApi;
  trans: Trans;
  ceval: CevalCtrl;
  evalCache: EvalCache;

  // current tree state, cursor, and denormalized node lists
  path: Tree.Path;
  node: Tree.Node;
  nodeList: Tree.Node[];
  mainline: Tree.Node[];

  // sub controllers
  actionMenu: ActionMenuCtrl;
  autoplay: Autoplay;
  explorer: ExplorerCtrl;
  forecast?: ForecastCtrl;
  retro?: RetroCtrl;
  fork: ForkCtrl;
  practice?: PracticeCtrl;
  study?: StudyCtrl;
  studyPractice?: StudyPracticeCtrl;

  // state flags
  justPlayed?: string; // pos
  justDropped?: string; // role
  justCaptured?: JustCaptured;
  autoScrollRequested: boolean = false;
  redirecting: boolean = false;
  onMainline: boolean = true;
  synthetic: boolean; // false if coming from a real game
  ongoing: boolean; // true if real game is ongoing

  // display flags
  flipped: boolean = false;
  embed: boolean;
  showComments: boolean = true; // whether to display comments in the move tree
  showAutoShapes: StoredBooleanProp = storedProp('show-auto-shapes', true);
  showGauge: StoredBooleanProp = storedProp('show-gauge', true);
  showComputer: StoredBooleanProp = storedProp('show-computer', true);
  keyboardHelp: boolean = location.hash === '#keyboard';
  threatMode: Prop<boolean> = prop(false);
  treeView: TreeView;
  cgVersion = {
    js: 1, // increment to recreate draughtsground
    dom: 1
  };

  // other paths
  initialPath: Tree.Path;
  contextMenuPath?: Tree.Path;
  gamePath?: Tree.Path;

  // misc
  cgConfig: any; // latest draughtsground config (useful for revert)
  music?: any;
  skipSteps: number;

  constructor(opts: AnalyseOpts, redraw: () => void) {

    this.opts = opts;
    this.data = opts.data;
    this.element = opts.element;
    this.embed = opts.embed;
    this.redraw = redraw;
    this.trans = opts.trans;
    this.treeView = treeViewCtrl(opts.embed ? 'inline' : 'column');

    if (this.data.forecast) this.forecast = makeForecast(this.data.forecast, this.data, redraw);

    this.instanciateEvalCache();

    this.initialize(this.data, false);

    this.instanciateCeval();

    this.initialPath = treePath.root;

    if (opts.initialPly) {
      const loc = window.location,
        intHash = loc.hash === '#last' ? this.tree.lastPly() : parseInt(loc.hash.substr(1)),
        plyStr = opts.initialPly === 'url' ? (intHash || '') : opts.initialPly;
      // remove location hash - http://stackoverflow.com/questions/1397329/how-to-remove-the-hash-from-window-location-with-javascript-without-page-refresh/5298684#5298684
      if (intHash) window.history.pushState("", document.title, loc.pathname + loc.search);
      const mainline = treeOps.mainlineNodeList(this.tree.root);
      if (plyStr === 'last') this.initialPath = treePath.fromNodeList(mainline);
      else {
        const ply = parseInt(plyStr as string);
        if (ply) this.initialPath = treeOps.takePathWhile(mainline, n => (n.displayPly ? n.displayPly : n.ply) <= ply);
      }
    }

    this.setPath(this.initialPath);

    this.skipSteps = this.tree.getCurrentNodesAfterPly(this.nodeList, this.mainline, this.data.game.turns).length;

    this.study = opts.study ? makeStudy(opts.study, this, (opts.tagTypes || '').split(','), opts.practice, opts.relay) : undefined;
    this.studyPractice = this.study ? this.study.practice : undefined;

    this.showGround();
    this.onToggleComputer();
    this.startCeval();
    this.explorer.setNode();

    if (location.hash === '#practice' || (this.study && this.study.data.chapter.practice)) this.togglePractice();
    else if (location.hash === '#menu') li.requestIdleCallback(this.actionMenu.toggle);

    keyboard.bind(this);

    li.pubsub.on('jump', (ply: any) => {
      this.jumpToMain(parseInt(ply));
      this.redraw();
    });

    li.pubsub.on('sound_set', (set: string) => {
      if (!this.music && set === 'music')
        li.loadScript('/assets/javascripts/music/replay.js').then(() => {
          this.music = window.lidraughtsReplayMusic();
        });
      if (this.music && set !== 'music') this.music = null;
    });

    li.pubsub.on('analysis.change.trigger', this.onChange);
    li.pubsub.on('analysis.chart.click', index => {
      this.jumpToIndex(index);
      this.redraw()
    });
  }

  initialize(data: AnalyseData, merge: boolean): void {
    this.data = data;
    this.synthetic = util.synthetic(data);
    this.ongoing = !this.synthetic && game.playable(data as GameData);

    const prevTree = merge && this.tree.root;
    this.tree = makeTree(treeOps.reconstruct(this.data.treeParts));
    if (prevTree) this.tree.merge(prevTree);

    this.actionMenu = new ActionMenuCtrl();
    this.autoplay = new Autoplay(this);
    if (this.socket) this.socket.clearCache();
    else this.socket = makeSocket(this.opts.socketSend, this);
    this.explorer = explorerCtrl(this, this.opts.explorer, this.explorer ? this.explorer.allowed() : !this.embed);
    this.gamePath = this.synthetic || this.ongoing ? undefined :
      treePath.fromNodeList(treeOps.mainlineNodeList(this.tree.root));
    this.fork = makeFork(this);
  }

  setPath = (path: Tree.Path): void => {
    this.path = path;
    this.nodeList = this.tree.getNodeList(path);
    this.node = treeOps.last(this.nodeList) as Tree.Node;
    this.mainline = treeOps.mainlineNodeList(this.tree.root);
    this.onMainline = this.tree.pathIsMainline(path)
  }

  flip = () => {
    this.flipped = !this.flipped;
    this.draughtsground.set({
      orientation: this.bottomColor()
    });
    if (this.retro) {
      this.retro = undefined;
      this.toggleRetro();
    }
    if (this.practice) this.restartPractice();
    this.redraw();
  }

  topColor(): Color {
    return opposite(this.bottomColor());
  }

  bottomColor(): Color {
    return this.flipped ? opposite(this.data.orientation) : this.data.orientation;
  }

  bottomIsWhite = () => this.bottomColor() === 'white';

  getOrientation(): Color { // required by ui/ceval
    return this.bottomColor();
  }
  getNode(): Tree.Node { // required by ui/ceval
    return this.node;
  }
  getCevalNode(): Tree.Node { // required by ui/ceval
    return (this.nodeList.length > 1 && this.node.displayPly && this.node.displayPly !== this.node.ply) ? this.nodeList[this.nodeList.length - 2] : this.node;
  }

  turnColor(): Color {
    return util.plyColor(this.node.ply);
  }

  togglePlay(delay: AutoplayDelay): void {
    this.autoplay.toggle(delay);
    this.actionMenu.open = false;
  }

  private uciToLastMove(uci?: Uci): Key[] | undefined {
    if (!uci)
      return;
    else
      return draughtsUtil.decomposeUci(uci);

  };

  private showGround(noCaptSequences: boolean = false): void {
    this.onChange();
    if (!defined(this.node.dests)) this.getDests();
    this.withCg(cg => {
      const cgOps = this.makeCgOpts();
      cg.set(cgOps, noCaptSequences);
      this.setAutoShapes();
      if (this.node.shapes) cg.setShapes(this.node.shapes as DrawShape[]);
    });
  }

  getDests: () => void = throttle(800, () => {
    const gamebook = this.gamebookPlay();
    if (this.embed && gamebook && !defined(this.node.dests)) {
      let dests = calcDests(this.node.fen, this.data.game.variant.key);
      if (dests.length > 1 && dests[0] === '#') {
        const nextUci = gamebook.nextUci();
        if (nextUci && nextUci.length >= 4) {
          this.node.captLen = nextUci.length / 2 - 1;
          dests = "#" + this.node.captLen.toString() + dests.substr(2);
        }
      }
      this.addDests(dests, this.path);
    }
    else if (!this.embed && !defined(this.node.dests))
      this.socket.sendAnaDests({
        variant: this.data.game.variant.key,
        fen: this.node.fen,
        path: this.path
      });
  });

  makeCgOpts(): DraughtsgroundConfig {
    const node = this.node,
      dests = draughtsUtil.readDests(this.node.dests),
      drops = draughtsUtil.readDrops(this.node.drops),
      captLen = draughtsUtil.readCaptureLength(this.node.dests),
      color = this.turnColor(),
      movableColor = (this.practice || this.gamebookPlay()) ? this.bottomColor() : (
        !this.embed && (
          (dests && Object.keys(dests).length > 0) ||
          drops === null || drops.length
        ) ? color : undefined),
      config: DraughtsgroundConfig = {
        fen: node.fen,
        turnColor: color,
        captureLength: captLen,
        movable: (this.embed && !this.gamebookPlay()) ? {
          color: undefined,
          dests: {} as CgDests
        } : {
            color: movableColor,
            dests: (movableColor === color ? (dests || {}) : {}) as CgDests
          },
        lastMove: this.uciToLastMove(node.uci),
      };
    if (!dests && !node.check) {
      // premove while dests are loading from server
      // can't use when in check because it highlights the wrong king
      config.turnColor = opposite(color);
      config.movable!.color = color;
    }
    config.premovable = {
      enabled: config.movable!.color && config.turnColor !== config.movable!.color && !this.gamebookPlay()
    };
    this.cgConfig = config;
    return config;
  }

  private sound = li.sound ? {
    move: throttle(50, li.sound.move),
    capture: throttle(50, li.sound.capture),
    check: throttle(50, li.sound.check)
  } : {
      move: $.noop,
      capture: $.noop,
      check: $.noop
    };

  private onChange: () => void = throttle(300, () => {
    li.pubsub.emit('analysis.change')(this.node.fen, this.path, this.onMainline ? (this.node.displayPly ? this.node.displayPly : this.node.ply) : false);
  });

  private updateHref: () => void = li.fp.debounce(() => {
    if (!this.opts.study) window.history.replaceState(null, '', '#' + this.node.ply);
  }, 750);

  autoScroll(): void {
    this.autoScrollRequested = true;
  }

  playedLastMoveMyself = () =>
    !!this.justPlayed && !!this.node.uci && this.node.uci.substr(this.node.uci.length - 4, 2) === this.justPlayed;


  jump(path: Tree.Path): void {
    const pathChanged = path !== this.path;
    const oldPly = this.node.displayPly ? this.node.displayPly : this.node.ply;
    this.setPath(path);
    this.showGround(Math.abs(oldPly - (this.node.displayPly ? this.node.displayPly : this.node.ply)) > 1);
    if (pathChanged) {
      const playedMyself = this.playedLastMoveMyself();
      if (this.study) this.study.setPath(path, this.node, playedMyself);
      if (!this.node.uci) this.sound.move(); // initial position
      else if (!playedMyself) {
        if (this.node.san!.indexOf('x') !== -1) this.sound.capture();
        else this.sound.move();
      }
      this.threatMode(false);
      this.ceval.stop();
      this.startCeval();
    }
    this.justPlayed = this.justDropped = this.justCaptured = undefined;
    this.explorer.setNode();
    this.updateHref();
    this.autoScroll();
    if (pathChanged) {
      if (this.retro) this.retro.onJump();
      if (this.practice) this.practice.onJump();
      if (this.study) this.study.onJump();
    }
    if (this.music) this.music.jump(this.node);
  }

  userJump = (path: Tree.Path): void => {
    this.autoplay.stop();
    this.withCg(cg => cg.selectSquare(null));
    if (this.practice) {
      const prev = this.path;
      this.practice.preUserJump(prev, path);
      this.jump(path);
      this.practice.postUserJump(prev, this.path);
    } else {
      this.jump(path);
    }
  }

  private canJumpTo(path: Tree.Path): boolean {
    return !this.study || this.study.canJumpTo(path);
  }

  userJumpIfCan(path: Tree.Path): void {
    if (this.canJumpTo(path)) this.userJump(path);
  }

  mainlinePathToPly(ply: Ply): Tree.Path {
    return treeOps.takePathWhile(this.mainline, n => (n.displayPly ? n.displayPly : n.ply) <= ply);
  }

  jumpToMain = (ply: Ply): void => {
    this.userJump(this.mainlinePathToPly(ply));
  }

  jumpToIndex = (index: number): void => {
    this.jumpToMain(index + 1 + this.tree.root.ply);
  }

  jumpToGlyphSymbol(color: Color, symbol: string): void {
    const node = nextGlyphSymbol(color, symbol, this.mainline, this.node.ply);
    if (node) this.jumpToMain(node.ply);
    this.redraw();
  }

  reloadData(data: AnalyseData, merge: boolean): void {
    if (data.puzzleEditor === undefined)
      data.puzzleEditor = this.data.puzzleEditor;
    this.initialize(data, merge);
    this.redirecting = false;
    this.setPath(treePath.root);
    this.instanciateCeval();
    this.instanciateEvalCache();
    this.cgVersion.js++;
  }

  changePdn(pdn: string): void {
    this.redirecting = true;
    $.ajax({
      url: '/analysis/pdn',
      method: 'post',
      data: { pdn },
      success: (data: AnalyseData) => {
        this.reloadData(data, false);
        this.userJump(this.mainlinePathToPly(this.tree.lastPly()));
        this.redraw();
      },
      error: error => {
        console.log(error);
        this.redirecting = false;
        this.redraw();
      }
    });
  }

  changeFen(fen: Fen): void {
    this.redirecting = true;
    window.location.href = '/analysis/' + (this.data.puzzleEditor ? 'puzzle/' : '') + this.data.game.variant.key + '/' + encodeURIComponent(fen).replace(/%20/g, '_').replace(/%2F/g, '/');
  }

  userNewPiece = (piece: cg.Piece, pos: Key): void => {
    if (crazyValid(this.draughtsground, this.node.drops, piece, pos)) {
      this.justPlayed = piece.role + '@' + pos;
      this.justDropped = piece.role;
      this.justCaptured = undefined;
      this.sound.move();
      const drop = {
        role: piece.role,
        pos,
        variant: this.data.game.variant.key,
        fen: this.node.fen,
        path: this.path
      };
      this.socket.sendAnaDrop(drop);
      this.preparePremoving();
      this.redraw();
    } else this.jump(this.path);
  }

  userMove = (orig: Key, dest: Key, capture?: JustCaptured): void => {
    this.justPlayed = orig;
    this.justDropped = undefined;
    this.sound[capture ? 'capture' : 'move']();
    this.sendMove(orig, dest, capture);
  }

  private gamebookMove(orig: Key, dest: Key, gamebook: GamebookPlayCtrl): void {
    const key2id = (key: Key) => String.fromCharCode(35 + parseInt(key) - 1),
      ghosts = countGhosts(this.node.fen);
    const uci: string = (ghosts == 0 || !this.node.uci) ? (orig + dest) : (this.node.uci + dest);
    let treeNode = gamebook.tryJump(uci)
    if (treeNode) {
      if (this.node.captLen && (ghosts != 0 || this.node.captLen > 1)) {
        treeNode = treeOps.copyNode(ghosts == 0 ? treeNode : this.node);
        treeNode.uci = uci.substr(uci.length - 4);
        if (treeNode.san) {
          const capt = treeNode.san.indexOf('x');
          if (capt !== -1) {
            if (ghosts == 0)
              treeNode.san = treeNode.san.substr(0, capt + 1) + parseInt(uci.substr(uci.length - 2, 2)).toString();
            else
              treeNode.san = treeNode.san.substr(capt + 1) + "x" + parseInt(uci.substr(uci.length - 2, 2)).toString();
          }
        }
        if (ghosts == 0) {
          treeNode.id = treeNode.id.substr(0, 1) + key2id(dest);
          treeNode.comments = undefined;
        } else
          treeNode.id = treeNode.id.substr(1, 1) + key2id(dest);
        treeNode.captLen = this.node.captLen - 1;
        if (treeNode.captLen == 0) {
          treeNode.ply = this.node.ply + 1;
          treeNode.displayPly = treeNode.ply;
        } else {
          treeNode.ply = this.node.ply;
          treeNode.displayPly = treeNode.ply + 1;
        }
        const sideToMove = treeNode.captLen != 0 ? this.node.fen[0] : (this.node.fen[0] == 'W' ? 'B' : 'W');
        const fenParts = treeNode.fen.split(':');
        treeNode.fen = sideToMove + ":" + this.draughtsground.getFen();
        if (fenParts.length > 3)
          treeNode.fen += ":" + fenParts.slice(3).join(':');
        if (treeNode.captLen > 0) {
          treeNode.dests = calcDests(treeNode.fen, this.data.game.variant.key);
          treeNode.dests = "#" + treeNode.captLen.toString() + treeNode.dests.substr(2);
        } else
          treeNode.dests = undefined;
      }
      if (!treeNode.dests) {
        treeNode.dests = calcDests(treeNode.fen, this.data.game.variant.key);
        if (treeNode.dests.length > 1 && treeNode.dests[0] === '#') {
          const nextUci = gamebook.peekUci();
          if (nextUci && nextUci.length >= 4) {
            treeNode.captLen = nextUci.length / 2 - 1;
            treeNode.dests = "#" + treeNode.captLen.toString() + treeNode.dests.substr(2);
          }
        }
      }
      this.addNode(treeNode, this.path);
    }
  }

  sendMove = (orig: Key, dest: Key, capture?: JustCaptured, prom?: cg.Role): void => {
    const move: any = {
      orig,
      dest,
      variant: this.data.game.variant.key,
      fen: this.node.fen,
      path: this.path
    };
    if (capture) this.justCaptured = capture;
    if (prom) move.promotion = prom;
    if (this.practice) this.practice.onUserMove();
    const gamebook = this.gamebookPlay();
    if (this.embed && gamebook) {
      this.gamebookMove(orig, dest, gamebook);
    } else {
      this.socket.sendAnaMove(move);
      this.preparePremoving();
    }
    this.redraw();
  }

  private preparePremoving(): void {
    this.draughtsground.set({
      //turnColor: this.draughtsground.state.movable.color as cg.Color,
      turnColor: opposite(this.draughtsground.state.turnColor as cg.Color),
      movable: {
        //color: opposite(this.draughtsground.state.movable.color as cg.Color)
        color: this.draughtsground.state.turnColor as cg.Color
      },
      premovable: {
        enabled: true
      }
    });
  }

  addNode(node: Tree.Node, path: Tree.Path) {
    const newPath = this.tree.addNode(node, path, this.data.puzzleEditor);
    if (!newPath) {
      console.log("Can't addNode", node, path);
      return this.redraw();
    }
    this.jump(newPath);
    this.redraw();
    this.draughtsground.playPremove();
  }

  addDests(dests: string, path: Tree.Path, opening?: Tree.Opening): void {
    this.tree.addDests(dests, path, opening);
    if (path === this.path) {
      this.showGround();
      // this.redraw();
      if (this.gameOver()) this.ceval.stop();
    }
    this.withCg(cg => cg.playPremove());
  }

  deleteNode(path: Tree.Path): void {
    const node = this.tree.nodeAtPath(path);
    if (!node) return;
    const count = treeOps.countChildrenAndComments(node);
    if ((count.nodes >= 10 || count.comments > 0) && !confirm(
      'Delete ' + util.plural('move', count.nodes) + (count.comments ? ' and ' + util.plural('comment', count.comments) : '') + '?'
    )) return;
    this.tree.deleteNodeAt(path);
    if (treePath.contains(this.path, path)) this.userJump(treePath.init(path));
    else this.jump(this.path);
    if (this.study) this.study.deleteNode(path);
  }

  promote(path: Tree.Path, toMainline: boolean): void {
    this.tree.promoteAt(path, toMainline);
    this.jump(path);
    if (this.study) this.study.promote(path, toMainline);
  }

  reset(): void {
    this.showGround();
    this.redraw();
  }

  encodeNodeFen(): Fen {
    return this.node.fen.replace(/\s/g, '_');
  }

  currentEvals() {
    const evalNode = this.getCevalNode();
    return {
      server: evalNode.eval,
      client: evalNode.ceval
    };
  }

  private pickUci(compChild?: Tree.Node, nextBest?: string) {
    if (!nextBest)
      return undefined;
    else if (!!compChild && compChild.uci && compChild.uci.length > nextBest.length && compChild.uci.slice(0, 2) === nextBest.slice(0, 2) && compChild.uci.slice(compChild.uci.length - 2) === nextBest.slice(nextBest.length - 2))
      return compChild.uci;
    else
      return nextBest;
  }

  nextNodeBest() {
    return treeOps.withMainlineChild(this.node, (n: Tree.Node) => n.eval ? this.pickUci(getCompChild(this.node), n.eval.best) : undefined);
  }

  setAutoShapes = (): void => {
    this.withCg(cg => cg.setAutoShapes(computeAutoShapes(this)));
  }

  private onNewCeval = (ev: Tree.ClientEval, path: Tree.Path, isThreat: boolean): void => {
    this.tree.updateAt(path, (node: Tree.Node) => {
      if (node.fen !== ev.fen && !isThreat) return;
      if (isThreat) {
        if (!node.threat || isEvalBetter(ev, node.threat) || node.threat.maxDepth < ev.maxDepth)
          node.threat = ev;
      } else if (isEvalBetter(ev, node.ceval)) node.ceval = ev;
      else if (node.ceval && ev.maxDepth > node.ceval.maxDepth) node.ceval.maxDepth = ev.maxDepth;

      if (path === this.path) {
        this.setAutoShapes();
        if (!isThreat) {
          if (this.retro) this.retro.onCeval();
          if (this.practice) this.practice.onCeval();
          if (this.studyPractice) this.studyPractice.onCeval();
          this.evalCache.onCeval();
          if (ev.cloud && ev.depth >= this.ceval.effectiveMaxDepth()) this.ceval.stop();
        }
        this.redraw();
      }
    });
  }

  private instanciateCeval(failsafe: boolean = false): void {
    if (this.ceval) this.ceval.destroy();
    const cfg: CevalOpts = {
      variant: this.data.game.variant,
      possible: !this.embed &&
        (this.data.game.variant.key === 'standard' || this.data.game.variant.key === 'fromPosition' || this.data.game.variant.key === 'breakthrough') &&
        (this.synthetic || !game.playable(this.data)),
      emit: (ev: Tree.ClientEval, work: CevalWork) => {
        this.onNewCeval(ev, work.path, work.threatMode);
      },
      setAutoShapes: this.setAutoShapes,
      failsafe,
      onCrash: lastError => {
        const ceval = this.node.ceval;
        console.log('Local eval failed after depth ' + (ceval && ceval.depth), lastError);
        if (this.ceval.pnaclSupported) {
          if (ceval && ceval.depth >= 20 && !ceval.retried) {
            console.log('Remain on native WASM/ASMJS for now');
            ceval.retried = true;
          } else {
            console.log('Fallback to ASMJS now');
            this.instanciateCeval(true);
            this.startCeval();
          }
        }
      },
      redraw: this.redraw
    };
    if (this.opts.study && this.opts.practice) {
      cfg.storageKeyPrefix = 'practice';
      cfg.multiPvDefault = 1;
    }
    this.ceval = cevalCtrl(cfg);
  }

  getCeval() {
    return this.ceval;
  }

  gameOver(node?: Tree.Node): 'draw' | 'checkmate' | false {
    const n = node || this.node;
    if (n.dests !== '' || n.drops) return false;
    if (n.check) return 'checkmate';
    return 'draw';
  }

  canUseCeval(): boolean {
    return !this.gameOver() && !this.node.threefold;
  }

  startCeval = throttle(800, () => {
    if (this.ceval.enabled()) {
      if (this.canUseCeval()) {
        // only analyze startingposition of multicaptures
        const ghostEnd = (this.nodeList.length > 0 && this.node.displayPly && this.node.displayPly !== this.node.ply);
        const path = ghostEnd ? this.path.slice(2) : this.path;
        const nodeList = ghostEnd ? this.nodeList.slice(1) : this.nodeList;
        this.ceval.start(path, nodeList, this.threatMode(), false);
        this.evalCache.fetch(path, parseInt(this.ceval.multiPv()));
      } else this.ceval.stop();
    }
  });

  toggleCeval = () => {
    this.ceval.toggle();
    this.setAutoShapes();
    this.startCeval();
    if (!this.ceval.enabled()) {
      this.threatMode(false);
      if (this.practice) this.togglePractice();
    }
    this.redraw();
  }

  toggleThreatMode = () => {
    if (this.node.displayPly && this.node.displayPly !== this.node.ply) return;
    if (!this.ceval.enabled()) this.ceval.toggle();
    if (!this.ceval.enabled()) return;
    this.threatMode(!this.threatMode());
    if (this.threatMode() && this.practice) this.togglePractice();
    this.setAutoShapes();
    this.startCeval();
    this.redraw();
  }

  disableThreatMode = (): boolean => {
    return !!this.practice;
  }

  mandatoryCeval = (): boolean => {
    return !!this.studyPractice;
  }

  private cevalReset(): void {
    this.ceval.stop();
    if (!this.ceval.enabled()) this.ceval.toggle();
    this.startCeval();
    this.redraw();
  }

  cevalSetMultiPv = (v: number): void => {
    this.ceval.multiPv(v);
    this.tree.removeCeval();
    this.cevalReset();
  }

  cevalSetThreads = (v: number): void => {
    this.ceval.threads(v);
    this.cevalReset();
  }

  cevalSetHashSize = (v: number): void => {
    this.ceval.hashSize(v);
    this.cevalReset();
  }

  cevalSetInfinite = (v: boolean): void => {
    this.ceval.infinite(v);
    this.cevalReset();
  }

  showEvalGauge(): boolean {
    return this.hasAnyComputerAnalysis() && this.showGauge() && !this.gameOver() && this.showComputer();
  }

  hasAnyComputerAnalysis(): boolean {
    return this.data.analysis ? true : this.ceval.enabled();
  }

  hasFullComputerAnalysis = (): boolean => {
    return Object.keys(this.mainline[0].eval || {}).length > 0;
  }

  private resetAutoShapes() {
    if (this.showAutoShapes()) this.setAutoShapes();
    else this.draughtsground && this.draughtsground.setAutoShapes([]);
  }

  toggleAutoShapes = (v: boolean): void => {
    this.showAutoShapes(v);
    this.resetAutoShapes();
  }

  toggleGauge = () => {
    this.showGauge(!this.showGauge());
  }

  private onToggleComputer() {
    if (!this.showComputer()) {
      this.tree.removeComputerVariations();
      if (this.ceval.enabled()) this.toggleCeval();
      this.draughtsground && this.draughtsground.setAutoShapes([]);
    } else this.resetAutoShapes();
  }

  toggleComputer = () => {
    const value = !this.showComputer();
    this.showComputer(value);
    if (!value && this.practice) this.togglePractice();
    if (this.opts.onToggleComputer) this.opts.onToggleComputer(value);
    this.onToggleComputer();
  }

  mergeAnalysisData(data: ServerEvalData): void {
    if (this.study && this.study.data.chapter.id !== data.ch) return;
    this.tree.merge(data.tree);
    if (!this.showComputer()) this.tree.removeComputerVariations();
    this.data.analysis = data.analysis;
    if (data.analysis) data.analysis.partial = !!treeOps.findInMainline(data.tree, n => !n.eval);
    if (data.division) this.data.game.division = data.division;
    if (this.retro) this.retro.onMergeAnalysisData();
    if (this.study) this.study.serverEval.onMergeAnalysisData();
    this.redraw();
  }

  playUci(uci: Uci): void {
    const move = draughtsUtil.decomposeUci(uci);
    const capture = this.draughtsground.state.pieces[move[1]];
    //const promotion = move[2] && draughtsUtil.sanToRole[move[2].toUpperCase()];
    this.sendMove(move[0], move[1], capture, undefined);
  }

  explorerMove(uci: Uci) {
    this.playUci(uci);
    this.explorer.loading(true);
  }

  playBestMove() {
    const uci = this.nextNodeBest() || (this.node.ceval && this.node.ceval.pvs[0].moves[0]);
    if (uci) this.playUci(uci);
  }

  canEvalGet = (node: Tree.Node): boolean => this.opts.study || node.ply < 15;

  instanciateEvalCache() {
    this.evalCache = makeEvalCache({
      variant: this.data.game.variant.key,
      canGet: this.canEvalGet,
      canPut: (node: Tree.Node) => {
        return this.data.evalPut && this.canEvalGet(node) && (
          // if not in study, only put decent opening moves
          this.opts.study || (!node.ceval!.win && Math.abs(node.ceval!.cp!) < 99)
        );
      },
      getNode: () => this.node,
      send: this.opts.socketSend,
      receive: this.onNewCeval
    });
  }

  toggleRetro = (): void => {
    if (this.retro) this.retro = undefined;
    else {
      this.retro = makeRetro(this);
      if (this.practice) this.togglePractice();
      if (this.explorer.enabled()) this.toggleExplorer();
    }
    this.setAutoShapes();
  }

  toggleExplorer = (): void => {
    if (this.practice) this.togglePractice();
    this.explorer.toggle();
  }

  togglePractice = () => {
    if (this.practice || !this.ceval.possible) this.practice = undefined;
    else {
      if (this.retro) this.toggleRetro();
      if (this.explorer.enabled()) this.toggleExplorer();
      this.practice = makePractice(this, () => {
        // push to 20 to store AI moves in the cloud
        // lower to 18 after task completion (or failure)
        return this.studyPractice && this.studyPractice.success() === null ? 20 : 18;
      });
    }
    this.setAutoShapes();
  };

  restartPractice() {
    this.practice = undefined;
    this.togglePractice();
  }

  gamebookPlay = (): GamebookPlayCtrl | undefined => {
    return this.study && this.study.gamebookPlay();
  }

  isGamebook = (): boolean => !!(this.study && this.study.data.chapter.gamebook);

  withCg<A>(f: (cg: DraughtsgroundApi) => A): A | undefined {
    if (this.draughtsground && this.cgVersion.js === this.cgVersion.dom)
      return f(this.draughtsground);
  }

};
