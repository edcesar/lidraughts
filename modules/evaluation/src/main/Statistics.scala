package lidraughts.evaluation

import draughts.{ Centis, Stats }
import lidraughts.common.Maths

object Statistics {

  // Coefficient of Variance
  def coefVariation(a: List[Int]): Option[Float] = {
    val s = Stats(a)
    s.stdDev.map { _ / s.mean }
  }

  // ups all values by 0.5s
  // as to avoid very high variation on bullet games
  // where all move times are low (https://lidraughts.org/@/AlisaP?mod)
  def moveTimeCoefVariation(a: List[Centis]): Option[Float] =
    coefVariation(a.map(_.centis + 50))

  def moveTimeCoefVariation(pov: lidraughts.game.Pov): Option[Float] =
    for {
      mt <- pov.game.moveTimes(pov.color)
      coef <- moveTimeCoefVariation(mt)
    } yield coef

  def consistentMoveTimes(pov: lidraughts.game.Pov): Boolean =
    moveTimeCoefVariation(pov) ?? (_ < 0.4)

  private val fastMove = Centis(50)
  def noFastMoves(pov: lidraughts.game.Pov): Boolean = {
    val moveTimes = ~pov.game.moveTimes(pov.color)
    moveTimes.count(fastMove >) <= (moveTimes.size / 20) + 2
  }

  def listAverage[T: Numeric](x: List[T]) = ~Maths.mean(x)

  def listDeviation[T: Numeric](x: List[T]) = ~Stats(x).stdDev
}