package lidraughts.socket

import akka.pattern.ask
import ornicar.scalalib.Zero
import play.api.libs.iteratee.Iteratee
import play.api.libs.json._
import scala.concurrent.duration._

import actorApi._
import lidraughts.hub.actorApi.relation.ReloadOnlineFriends
import lidraughts.socket.Socket.makeMessage
import makeTimeout.large

object Handler {

  type Controller = PartialFunction[(String, JsObject), Unit]
  type Connecter = PartialFunction[Any, (Controller, JsEnumerator, SocketMember)]

  val emptyController: Controller = PartialFunction.empty

  private val AnaRateLimiter = new lidraughts.memo.RateLimit[String](120, 30 seconds,
    name = "socket analysis move",
    key = "socket_analysis_move")

  def AnaRateLimit[A: Zero](uid: String, member: SocketMember)(op: => A) =
    AnaRateLimiter(uid, msg = s"user: ${member.userId | "anon"}")(op)

  def apply(
    hub: lidraughts.hub.Env,
    socket: akka.actor.ActorRef,
    uid: Socket.Uid,
    join: Any
  )(connecter: Connecter): Fu[JsSocketHandler] = {

    def baseController(member: SocketMember): Controller = {
      case ("p", o) => socket ! Ping(uid, o)
      case ("following_onlines", _) => member.userId foreach { u =>
        hub.actor.relation ! ReloadOnlineFriends(u)
      }
      case ("startWatching", o) => o str "d" foreach { ids =>
        hub.actor.moveBroadcast ! StartWatching(uid.value, member, ids.split(' ').toSet)
      }
      case ("moveLat", o) => hub.channel.roundMoveTime ! (~(o boolean "d")).fold(
        Channel.Sub(member),
        Channel.UnSub(member)
      )
      case ("anaMove", o) => AnaRateLimit(uid.value, member) {
        AnaMove parse o foreach { anaMove =>
          member push {
            anaMove.branch(false) match {
              case scalaz.Success(node) => makeMessage("node", anaMove json node)
              case scalaz.Failure(err) => makeMessage("stepFailure", err.toString)
            }
          }
        }
      }
      case ("puzzleMove", o) => AnaRateLimit(uid.value, member) {
        AnaMove parse o foreach { anaMove =>
          member push {
            anaMove.branch(true) match {
              case scalaz.Success(node) => makeMessage("node", anaMove json node)
              case scalaz.Failure(err) => makeMessage("stepFailure", err.toString)
            }
          }
        }
      }
      case ("anaDests", o) => AnaRateLimit(uid.value, member) {
        member push {
          AnaDests parse o match {
            case Some(res) => makeMessage("dests", res.json)
            case None => makeMessage("destsFailure", "Bad dests request")
          }
        }
      }
      case ("opening", o) => AnaRateLimit(uid.value, member) {
        GetOpening(o) foreach { res =>
          member push makeMessage("opening", res)
        }
      }
      case ("notified", _) => member.userId foreach { userId =>
        hub.actor.notification ! lidraughts.hub.actorApi.notify.Notified(userId)
      }
      case _ => // logwarn("Unhandled msg: " + msg)
    }

    def iteratee(controller: Controller, member: SocketMember): JsIteratee = {
      val control = controller orElse baseController(member)
      Iteratee.foreach[JsValue](jsv =>
        jsv.asOpt[JsObject] foreach { obj =>
          obj str "t" foreach { t =>
            control.lift(t -> obj)
          }
        }).map(_ => socket ! Quit(uid.value))
    }

    socket ? join map connecter map {
      case (controller, enum, member) => iteratee(controller, member) -> enum
    }
  }
}
