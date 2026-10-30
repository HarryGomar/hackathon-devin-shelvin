import { useEffect } from 'react';
import { Platform } from 'react-native';
import {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInDown,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

// Reanimated's web entering animations leave views absolutely positioned (stacked on top of each other),
// so cards and steps just appear on web. Native keeps the motion.
const LAYOUT_ANIMATIONS = Platform.OS !== 'web';

/** Entering animation for cards: short fade with a small upward slide. None under Reduce Motion or on web. */
export function useEnterAnimation(delay = 0) {
  const reduced = useReducedMotion();
  if (reduced || !LAYOUT_ANIMATIONS) return undefined;
  return FadeInDown.duration(320)
    .delay(Math.min(delay, 360))
    .easing(Easing.out(Easing.cubic))
    .withInitialValues({ opacity: 0, transform: [{ translateY: 10 }] });
}

/** Plain fade for small swaps such as a progress step's icon. None under Reduce Motion or on web. */
export function useFadeIn() {
  const reduced = useReducedMotion();
  return reduced || !LAYOUT_ANIMATIONS ? undefined : FadeIn.duration(220);
}

/** 0 → 1 → 0 loop for placeholders. Stays at 0.5 under Reduce Motion. */
export function usePulse(duration: number): SharedValue<number> {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0.5);
  useEffect(() => {
    if (reduced) {
      progress.set(0.5);
      return;
    }
    progress.set(0);
    progress.set(withRepeat(withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }), -1, true));
    return () => cancelAnimation(progress);
  }, [reduced, duration, progress]);
  return progress;
}
