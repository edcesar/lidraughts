package controllers

import akka.pattern.ask
import play.api.data._, Forms._
import play.api.libs.json._
import play.api.mvc._

import lidraughts.app._
import lidraughts.api.Context
import lidraughts.common.HTTPRequest
import lidraughts.hub.actorApi.captcha.ValidCaptcha
import makeTimeout.large
import views._

object Main extends LidraughtsController {

  private lazy val blindForm = Form(tuple(
    "enable" -> nonEmptyText,
    "redirect" -> nonEmptyText
  ))

  def toggleBlindMode = OpenBody { implicit ctx =>
    implicit val req = ctx.body
    fuccess {
      blindForm.bindFromRequest.fold(
        err => BadRequest, {
          case (enable, redirect) =>
            Redirect(redirect) withCookies lidraughts.common.LidraughtsCookie.cookie(
              Env.api.Accessibility.blindCookieName,
              if (enable == "0") "" else Env.api.Accessibility.hash,
              maxAge = Env.api.Accessibility.blindCookieMaxAge.some,
              httpOnly = true.some
            )
        }
      )
    }
  }

  def websocket = SocketOption { implicit ctx =>
    getSocketUid("sri") ?? { uid =>
      Env.site.socketHandler(uid, ctx.userId, get("flag")) map some
    }
  }

  def apiWebsocket = WebSocket.tryAccept { req =>
    Env.site.apiSocketHandler.apply map Right.apply
  }

  def captchaCheck(id: String) = Open { implicit ctx =>
    Env.hub.actor.captcher ? ValidCaptcha(id, ~get("solution")) map {
      case valid: Boolean => Ok(valid fold (1, 0))
    }
  }

  def embed = Action { req =>
    Ok {
      s"""document.write("<iframe src='${Env.api.Net.BaseUrl}?embed=" + document.domain + "' class='lidraughts-iframe' allowtransparency='true' frameBorder='0' style='width: ${getInt("w", req) | 820}px; height: ${getInt("h", req) | 650}px;' title='Lidraughts free online draughts'></iframe>");"""
    } as JAVASCRIPT withHeaders (CACHE_CONTROL -> "max-age=86400")
  }

  def developers = Open { implicit ctx =>
    fuccess {
      html.site.developers()
    }
  }

  def lag = Open { implicit ctx =>
    fuccess {
      html.site.lag()
    }
  }

  def mobile = Open { implicit ctx =>
    OptionOk(Prismic getBookmark "mobile-apk") {
      case (doc, resolver) => html.mobile.home(doc, resolver)
    }
  }

  def mobileRegister(platform: String, deviceId: String) = Auth { implicit ctx => me =>
    Env.push.registerDevice(me, platform, deviceId)
  }

  def mobileUnregister = Auth { implicit ctx => me =>
    Env.push.unregisterDevices(me)
  }

  def jslog(id: String) = Open { ctx =>
    Env.round.selfReport(
      userId = ctx.userId,
      ip = HTTPRequest lastRemoteAddress ctx.req,
      fullId = id,
      name = get("n", ctx.req) | "?"
    )
    NoContent.fuccess
  }

  /**
   * Event monitoring endpoint
   */
  def jsmon(event: String) = Action {
    if (event == "socket_gap") lidraughts.mon.jsmon.socketGap()
    else lidraughts.mon.jsmon.unknown()
    NoContent
  }

  private lazy val glyphsResult: Result = {
    import draughts.format.pdn.Glyph
    import lidraughts.tree.Node.glyphWriter
    Ok(Json.obj(
      "move" -> Glyph.MoveAssessment.display,
      "position" -> Glyph.PositionAssessment.display,
      "observation" -> Glyph.Observation.display
    )) as JSON
  }
  val glyphs = Action(glyphsResult)

  def image(id: String, hash: String, name: String) = Action.async { req =>
    Env.db.image.fetch(id) map {
      case None => NotFound
      case Some(image) =>
        lidraughts.log("image").info(s"Serving ${image.path} to ${HTTPRequest printClient req}")
        Ok(image.data).withHeaders(
          CONTENT_TYPE -> image.contentType.getOrElse("image/jpeg"),
          CONTENT_DISPOSITION -> image.name,
          CONTENT_LENGTH -> image.size.toString
        )
    }
  }

  val robots = Action {
    Ok {
      if (Env.api.Net.Crawlable) """User-agent: *
Allow: /
Disallow: /game/export
Disallow: /games/export
"""
      else "User-agent: *\nDisallow: /"
    }
  }

  def renderNotFound(req: RequestHeader): Fu[Result] =
    reqToCtx(req) map renderNotFound

  def renderNotFound(ctx: Context): Result = {
    lidraughts.mon.http.response.code404()
    NotFound(html.base.notFound()(ctx))
  }

  def fpmenu = Open { implicit ctx =>
    Ok(html.base.fpmenu()).fuccess
  }

  def getDraughtsnet = Open { implicit ctx =>
    Ok(html.site.getDraughtsnet()).fuccess
  }
}
