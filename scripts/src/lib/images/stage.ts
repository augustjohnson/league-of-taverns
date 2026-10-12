/**
 * Where a painted portrait stands on the tavern stage (content/images/style.yaml
 * `stage`). Everyone stands on the floor, barFt below the bar top, and is drawn
 * at their height, so heads land where they belong: an 8 ft ogre towers over a
 * 4 ft dwarf. Short folk stand on a stool, the smallest stand on the bar, and
 * anything taller than the frame looms in with its head at the top.
 *
 * Lengths are feet. The renderer picks pixels per foot.
 */
import type { CreatureSize, ImageStyle } from './style';

export interface Placement {
  /** floor: behind the bar; bar: standing on it; loom: too tall for the frame, head at its top. */
  readonly where: 'floor' | 'bar' | 'loom';
  /** How tall the figure is drawn. */
  readonly shownFt: number;
  /** The top of the figure, above the bar top. Below the bar top, the bar hides it (except on the bar). */
  readonly topFt: number;
}

export function placeOnStage(style: ImageStyle, size: CreatureSize, heightFt: number): Placement {
  const { barFt, frameFt, minVisibleFt, minHiddenFt, onBarMaxFt, minShownFt, loomAboveFt } = style.stage;
  if (size === 'tiny' || heightFt <= onBarMaxFt) {
    const shownFt = Math.max(heightFt, minShownFt);
    return { where: 'bar', shownFt, topFt: shownFt };
  }
  if (size === 'huge' || size === 'gargantuan' || heightFt > loomAboveFt) {
    return { where: 'loom', shownFt: Math.min(heightFt, 2 * frameFt), topFt: frameFt };
  }
  const topFt = Math.max(heightFt - barFt, Math.min(minVisibleFt, heightFt - minHiddenFt));
  return { where: 'floor', shownFt: heightFt, topFt };
}
