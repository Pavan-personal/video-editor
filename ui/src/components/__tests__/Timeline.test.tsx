import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Timeline from '../Timeline';

describe('Timeline Component', () => {
  const baseProps = {
    clips: [],
    overlays: [],
    assets: [],
    currentTime: 0,
    onTimeChange: vi.fn(),
    onClipUpdate: vi.fn(),
    onClipDelete: vi.fn(),
    onSelectClip: vi.fn(),
    onSelectOverlay: vi.fn(),
    onOverlayDelete: vi.fn(),
    onOverlayUpdate: vi.fn(),
    selectedClipId: null,
    selectedOverlayId: null,
  };

  it('renders all track labels', () => {
    render(<Timeline {...baseProps} />);
    expect(screen.getByText('Video')).toBeTruthy();
    expect(screen.getByText('PiP')).toBeTruthy();
    expect(screen.getByText('Text')).toBeTruthy();
    expect(screen.getByText('Audio')).toBeTruthy();
  });

  it('renders a clip block on the timeline', () => {
    const clips = [{
      id: 'clip-abc123',
      projectId: 'p1',
      assetId: 'a1',
      track: 'video_a',
      startTime: 0,
      endTime: 5,
      trimStart: 0,
      speedKeyframes: [{ time: 0, speed: 1 }],
    }];
    render(<Timeline {...baseProps} clips={clips} />);
    expect(screen.getByText('clip-a')).toBeTruthy();
  });

  it('renders overlay blocks with stripped animation suffix', () => {
    const overlays = [{
      id: 'ov-1',
      projectId: 'p1',
      type: 'text',
      track: 'overlay_1',
      startTime: 0,
      endTime: 5,
      content: 'Hello World|||fade',
      positionKeyframes: [],
      scaleKeyframes: [],
      rotationKeyframes: [],
      opacityKeyframes: [],
    }];
    render(<Timeline {...baseProps} overlays={overlays} />);
    // Should show "Hello World" not "Hello World|||fade"
    expect(screen.getByText('Hello World')).toBeTruthy();
  });
});
