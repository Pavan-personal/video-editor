import { evaluateSpeedRamp, SpeedKeyframe } from '../src/utils/time-engine';

describe('Time Engine', () => {
  describe('evaluateSpeedRamp', () => {
    test('should handle speed ramp with acceleration', () => {
      const keyframes: SpeedKeyframe[] = [
        { time: 0, speed: 1 },
        { time: 2, speed: 2 },
      ];

      // At time 0, speed is 1x
      expect(evaluateSpeedRamp(0, keyframes)).toBe(0);

      // At time 1, speed is 1.5x (interpolated)
      // Source time should be approximately 1.25 (average speed 1.25x over 1 second)
      const result = evaluateSpeedRamp(1, keyframes);
      expect(result).toBeGreaterThan(1);
      expect(result).toBeLessThan(1.5);

      // At time 2, speed is 2x
      // Source time should be 3 (1 second at 1x + 1 second at avg 1.5x)
      const result2 = evaluateSpeedRamp(2, keyframes);
      expect(result2).toBeCloseTo(3, 1);
    });

    test('should handle hold (0x speed)', () => {
      const keyframes: SpeedKeyframe[] = [
        { time: 0, speed: 1 },
        { time: 1, speed: 0 }, // Hold starts at 1 second
        { time: 3, speed: 1 }, // Resume at 3 seconds
      ];

      // At time 0.5, speed is ramping down from 1 to 0 (avg 0.75x)
      // Source time should be approximately 0.375 (0.5 * 0.75)
      const beforeHold = evaluateSpeedRamp(0.5, keyframes);
      expect(beforeHold).toBeGreaterThan(0.3);
      expect(beforeHold).toBeLessThan(0.5);

      // At time 1, hold begins (source time should be ~0.5)
      const holdStart = evaluateSpeedRamp(1, keyframes);
      expect(holdStart).toBeCloseTo(0.5, 1);
      
      // At time 2 (during hold), source time should advance very little
      // (speed ramps from 0 to 1 over 2 seconds, so avg speed is 0.5)
      const duringHold = evaluateSpeedRamp(2, keyframes);
      expect(duringHold).toBeGreaterThan(holdStart);
      expect(duringHold).toBeLessThan(holdStart + 1);

      // At time 3, hold ends and resumes
      const afterHold = evaluateSpeedRamp(3, keyframes);
      expect(afterHold).toBeGreaterThan(duringHold);
    });

    test('should handle no keyframes (1:1 mapping)', () => {
      expect(evaluateSpeedRamp(0, [])).toBe(0);
      expect(evaluateSpeedRamp(5, [])).toBe(5);
      expect(evaluateSpeedRamp(10.5, [])).toBe(10.5);
    });

    test('should handle single keyframe', () => {
      const keyframes: SpeedKeyframe[] = [
        { time: 0, speed: 2 },
      ];

      // All time should be at 2x speed
      expect(evaluateSpeedRamp(0, keyframes)).toBe(0);
      expect(evaluateSpeedRamp(1, keyframes)).toBe(2);
      expect(evaluateSpeedRamp(2, keyframes)).toBe(4);
    });
  });
});
