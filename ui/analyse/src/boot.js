var defined = require('common').defined;
var tree = require("tree")

module.exports = function(element, cfg) {
  var data = cfg.data;
  var $watchers = $('#site_header div.watchers').watchers();
  var analyse, $panels;
  lidraughts.socket = lidraughts.StrongSocket(
    data.url.socket,
    data.player.version, {
      options: {
        name: "analyse"
      },
      params: {
        userTv: data.userTv && data.userTv.id
      },
      receive: function(t, d) {
        analyse.socketReceive(t, d);
      },
      events: {
        analysisProgress: function(d) {
          var partial = !d.tree.eval;
          if (!lidraughts.advantageChart) startAdvantageChart();
          else if (lidraughts.advantageChart.update) lidraughts.advantageChart.update({ game: data.game, treeParts: tree.ops.mainlineNodeList(tree.build(d.tree).root) }, partial);
          if (!partial) $("#adv_chart_loader").remove();
        },
        crowd: function(event) {
          $watchers.watchers("set", event.watchers);
        }
      }
    });

  var $timeChart = $("#movetimes_chart");
  var inputFen = element.querySelector('input.fen');
  var unselect = function(chart) {
    chart.getSelectedPoints().forEach(function(point) {
      point.select(false);
    });
  };
  var lastFen;

  lidraughts.pubsub.on('analysis.change', function(fen, path, mainlinePly) {
    var chart, point, $chart = $("#adv_chart");
    if (fen && fen !== lastFen) {
      inputFen.value = fen;
      lastFen = fen;
    }
    if ($chart.length) {
      chart = window.Highcharts && $chart.highcharts();
      if (chart) {
        if (mainlinePly != chart.lastPly) {
          if (mainlinePly === false) unselect(chart);
          else {
            point = chart.series[0].data[mainlinePly - 1 - cfg.data.game.startedAtTurn];
            if (defined(point)) point.select();
            else unselect(chart);
          }
        }
        chart.lastPly = mainlinePly;
      }
    }
    if ($timeChart.length) {
      chart = window.Highcharts && $timeChart.highcharts();
      if (chart) {
        if (mainlinePly != chart.lastPly) {
          if (mainlinePly === false) unselect(chart);
          else {
            var white = mainlinePly % 2 !== 0;
            var serie = white ? 0 : 1;
            var turn = Math.floor((mainlinePly - 1 - cfg.data.game.startedAtTurn) / 2);
            point = chart.series[serie].data[turn];
            if (defined(point)) point.select();
            else unselect(chart);
          }
        }
        chart.lastPly = mainlinePly;
      }
    }
  });
  cfg.onToggleComputer = function(v) {
    setTimeout(function() {
      if (v) $('div.analysis_menu a.computer_analysis').mousedown();
      else $('div.analysis_menu a:eq(1)').mousedown();
    }, 50);
  };
  cfg.trans = lidraughts.trans(cfg.i18n);
  cfg.initialPly = 'url';
  cfg.element = element.querySelector('.analyse');
  cfg.socketSend = lidraughts.socket.send;
  analyse = LidraughtsAnalyse.start(cfg);
  cfg.jumpToIndex = analyse.jumpToIndex;

  if (cfg.chat) {
    cfg.chat.parseMoves = true;
    lidraughts.makeChat('chat', cfg.chat);
  }

  $('.underboard_content', element).appendTo($('.underboard .center', element)).removeClass('none');

  var chartLoader = function() {
    return '<div id="adv_chart_loader">' +
    '<span>' + lidraughts.engineName + '<br>server analysis</span>' +
    lidraughts.spinnerHtml +
    '</div>'
  };
  var startAdvantageChart = function() {
    if (lidraughts.advantageChart) return;
    var loading = !data.treeParts[0].eval || !Object.keys(data.treeParts[0].eval).length;
    var $panel = $panels.filter('.computer_analysis');
    if (!$("#adv_chart").length) $panel.html('<div id="adv_chart"></div>' + (loading ? chartLoader() : ''));
    else if (loading && !$("#adv_chart_loader").length) $panel.append(chartLoader());
    lidraughts.loadScript('/assets/javascripts/chart/acpl.js').then(function() {
      lidraughts.advantageChart(data, cfg.trans, $("#adv_chart")[0]);
    });
  };

  $panels = $('div.analysis_panels > div');
  var $menu = $('div.analysis_menu');
  var storage = lidraughts.storage.make('analysis.panel');
  var setPanel = function(panel) {
    $menu.children('.active').removeClass('active').end().find('.' + panel).addClass('active');
    $panels.removeClass('active').filter('.' + panel).addClass('active');
    if (panel === 'move_times' && !lidraughts.movetimeChart) try {
      lidraughts.loadScript('/assets/javascripts/chart/movetime.js').then(function() {
        lidraughts.movetimeChart(data, cfg.trans);
      });
    } catch (e) {}
    if (panel === 'computer_analysis' && $("#adv_chart").length)
      setTimeout(startAdvantageChart, 200);
  };
  $menu.on('mousedown', 'a', function() {
    var panel = $(this).data('panel');
    storage.set(panel);
    setPanel(panel);
  });
  var stored = storage.get();
  if (stored && $menu.children('.' + stored).length) setPanel(stored);
  else {
    var $ct = $menu.children('.crosstable');
    ($ct.length ? $ct : $menu.children(':first-child')).trigger('mousedown');
  }
  if (!cfg.data.analysis) {
    $panels.find('form.future_game_analysis').submit(function() {
      if ($(this).hasClass('must_login')) {
        if (confirm(cfg.trans('youNeedAnAccountToDoThat'))) location.href = '/signup';
        return false;
      }
      $.ajax({
        method: 'post',
        url: $(this).attr('action'),
        success: startAdvantageChart,
        error: lidraughts.reload
      });
      return false;
    });
  }

  $panels.on('click', 'div.pdn', function() {
    var range, selection;
    if (document.body.createTextRange) {
      range = document.body.createTextRange();
      range.moveToElementText($(this)[0]);
      range.select();
    } else if (window.getSelection) {
      selection = window.getSelection();
      range = document.createRange();
      range.selectNodeContents($(this)[0]);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
  $panels.on('click', '.embed_howto', function() {
    var url = 'https://lidraughts.org/embed/' + data.game.id + location.hash;
    var iframe = '<iframe src="' + url + '?theme=auto&bg=auto"\nwidth=600 height=397 frameborder=0></iframe>';
    $.modal($(
      '<strong style="font-size:1.5em">' + $(this).html() + '</strong><br /><br />' +
      '<pre>' + lidraughts.escapeHtml(iframe) + '</pre><br />' +
      iframe + '<br /><br />' +
      '<a class="text" data-icon="" href="/developers#embed-game">Read more about embedding games</a>'
    ));
  });
  lidraughts.topMenuIntent();
};
