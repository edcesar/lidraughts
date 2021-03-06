package lidraughts.game

import BSONHandlers._
import lidraughts.db.dsl._
import play.api.libs.iteratee._
import reactivemongo.play.iteratees.cursorProducer
import reactivemongo.bson._

object StreamTest {

  val max = 100000
  val concurrency = 4

  def readGame(bson: BSONDocument): Game =
    gameBSONHandler read bson

  def start(times: Int): Fu[String] = {
    GameRepo.coll
      .find($empty)
      .cursor[BSONDocument]()
      .enumerator(max) |>>>
      Iteratee.fold[BSONDocument, Int](0) {
        case (nb, doc) =>
          List.fill(concurrency)(doc).par.map(readGame)
          if (nb % 10000 == 0) println(nb)
          nb + 1
      }
  }.chronometer.lap.map { lap =>
    println(s"""${lap.result * concurrency} games in ${lap.millis}ms, ${lap.micros / lap.result / concurrency} micros per game""")
    lap.result
  } >> {
    if (times > 0) start(times - 1)
    else fuccess("done")
  }
}