package lidraughts.playban

import com.typesafe.config.Config

final class Env(
    config: Config,
    messenger: lidraughts.message.MessageApi,
    chatApi: lidraughts.chat.ChatApi,
    lightUser: lidraughts.common.LightUser.Getter,
    bus: lidraughts.common.Bus,
    db: lidraughts.db.Env
) {

  private val settings = new {
    val CollectionPlayban = config getString "collection.playban"
  }
  import settings._

  private lazy val feedback = new PlaybanFeedback(
    chatApi = chatApi,
    lightUser = lightUser
  )

  lazy val api = new PlaybanApi(
    coll = db(CollectionPlayban),
    sandbag = new SandbagWatch(messenger),
    feedback = feedback,
    bus = bus
  )
}

object Env {

  lazy val current: Env = "playban" boot new Env(
    config = lidraughts.common.PlayApp loadConfig "playban",
    messenger = lidraughts.message.Env.current.api,
    chatApi = lidraughts.chat.Env.current.api,
    lightUser = lidraughts.user.Env.current.lightUserApi.async,
    bus = lidraughts.common.PlayApp.system.lidraughtsBus,
    db = lidraughts.db.Env.current
  )
}
