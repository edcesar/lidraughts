package lidraughts.user

import org.joda.time.DateTime

case class Trophy(
    _id: String, // random
    user: String,
    kind: Trophy.Kind,
    date: DateTime
) extends Ordered[Trophy] {

  def timestamp = date.getMillis

  def compare(other: Trophy) =
    if (kind.order == other.kind.order) timestamp compare other.timestamp
    else kind.order compare other.kind.order
}

object Trophy {

  sealed abstract class Kind(
      val key: String,
      val name: String,
      val icon: Option[String],
      val url: Option[String],
      val klass: Option[String],
      val order: Int
  )

  object Kind {

    object WayOfBerserk extends Kind(
      key = "wayOfBerserk",
      name = "The way of Berserk",
      icon = "`".some,
      url = "//lidraughts.org/qa/340/way-of-berserk-trophy".some,
      klass = "fire_trophy".some,
      order = 2
    )

    object MarathonWinner extends Kind(
      key = "marathonWinner",
      name = "Marathon Winner",
      icon = "\\".some,
      url = none,
      klass = "fire_trophy".some,
      order = 3
    )

    object MarathonTopTen extends Kind(
      key = "marathonTopTen",
      name = "Marathon Top 10",
      icon = "\\".some,
      url = none,
      klass = "fire_trophy".some,
      order = 4
    )

    object MarathonTopFifty extends Kind(
      key = "marathonTopFifty",
      name = "Marathon Top 50",
      icon = "\\".some,
      url = none,
      klass = "fire_trophy".some,
      order = 5
    )

    object MarathonTopHundred extends Kind(
      key = "marathonTopHundred",
      name = "Marathon Top 100",
      icon = "\\".some,
      url = none,
      klass = "fire_trophy".some,
      order = 6
    )

    object MarathonSurvivor extends Kind(
      key = "marathonSurvivor",
      name = "Marathon #1 survivor",
      icon = ",".some,
      url = "//lidraughts.org/blog/VXF45yYAAPQgLH4d/draughts-marathon-1".some,
      klass = "fire_trophy".some,
      order = 7
    )

    object BongcloudWarrior extends Kind(
      key = "bongcloudWarrior",
      name = "Bongcloud Warrior",
      icon = "~".some,
      url = "//lidraughts.org/forum/lidraughts-feedback/bongcloud-trophy".some,
      klass = "fire_trophy".some,
      order = 8
    )

    object Developer extends Kind(
      key = "developer",
      name = "Lidraughts developer",
      icon = "&#xe000;".some,
      url = none,
      klass = "icon3d".some,
      order = 100
    )

    object Moderator extends Kind(
      key = "moderator",
      name = "Lidraughts moderator",
      icon = "&#xe002;".some,
      url = "//lidraughts.org/report".some,
      klass = "icon3d".some,
      order = 101
    )

    object ZHWC extends Kind(
      key = "zhwc",
      name = "Crazyhouse champion",
      icon = none,
      url = "//lidraughts.org/blog/WMnMzSEAAMgA3oAW/crazyhouse-world-championship-the-candidates".some,
      klass = none,
      order = 1
    )

    val all = List(
      Developer, Moderator,
      MarathonTopHundred, MarathonTopTen, MarathonTopFifty, MarathonWinner,
      ZHWC,
      WayOfBerserk,
      MarathonSurvivor,
      BongcloudWarrior
    )
    val byKey: Map[String, Kind] = all.map { k => k.key -> k }(scala.collection.breakOut)
  }

  def make(userId: String, kind: Trophy.Kind) = Trophy(
    _id = ornicar.scalalib.Random nextString 8,
    user = userId,
    kind = kind,
    date = DateTime.now
  )
}
