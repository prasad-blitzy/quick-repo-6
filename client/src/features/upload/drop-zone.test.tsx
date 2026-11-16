/**
 * Suite for the upload feature's drop zone: the two equal ways into the queue — one drop gesture,
 * or the operating-system picker behind a click, Enter or Space — and the removal a queued
 * screenshot offers.
 *
 * `DropZone` validates nothing and sends nothing, so the assertions divide along that seam. Bare
 * renders cover the zone's own contract: a gesture's files reach `onFiles` in one call, `dragover`
 * is cancelled so the browser accepts the drop, the active state follows `dragenter` and
 * `dragleave`, one activation opens the picker exactly once, the file input is clipped rather than
 * removed from rendering, and the zone is a labelled button reachable by tabbing to it. Renders of
 * `QueueHarness` below cover what the queue adds: a refused file is named with the shared sentence
 * for its code, and a queued screenshot leaves the queue when its Remove control is pressed with
 * Enter.
 *
 * jsdom implements neither `DataTransfer` nor `DragEvent`, so a drop is dispatched with a plain
 * `dataTransfer` object that Testing Library assigns to the event, and the sibling downscale module
 * is mocked because it needs `createImageBitmap` and a 2D canvas. No limit number is asserted
 * anywhere in this file: the sentence shown for a rejected file is read from the shared error
 * table, which is the one place the numbers live.
 */

import { act, createEvent, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { messageForCode } from '../../api/errors';
import { DropZone } from './drop-zone';
import { useImageQueue } from './use-image-queue';

/**
 * jsdom decodes no image, so the real module cannot run here: it awaits `createImageBitmap` and
 * draws through a 2D canvas context, and jsdom provides neither. The factory is self-contained
 * because Vitest hoists it above this file's imports.
 */
vi.mock('./downscale-image', () => ({
  computeTargetSize: (width: number, height: number) => ({ width, height }),
  isBlankFrame: () => false,
  downscaleImage: async (file: File) => ({
    blob: file,
    width: 1600,
    height: 900,
    blankFrame: false,
  }),
}));

/** A screenshot of a kind the picker's `accept` attribute admits. */
function pngFile(name: string): File {
  return new File(['chart screenshot bytes'], name, { type: 'image/png' });
}

/** The zone, found the way an operator's assistive technology would: by role and accessible name. */
function zoneIn(container: HTMLElement): HTMLElement {
  return within(container).getByRole('button', { name: /screenshots/i });
}

/** The clipped input the zone opens; the zone is the control, and this is the picker behind it. */
function fileInputIn(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) {
    throw new Error('The drop zone rendered no file input.');
  }
  return input;
}

/** Waits for the first element matching a selector that the queue renders after its microtasks. */
async function findOrFail(container: HTMLElement, selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = container.querySelector<HTMLElement>(selector);
    if (found === null) {
      throw new Error(`Nothing matched ${selector} yet.`);
    }
    return found;
  });
}

/**
 * One drop gesture onto `zone`.
 *
 * The queue prepares its files across a microtask, so the gesture is dispatched inside an async
 * `act`: the state that microtask commits has landed by the time the assertions read the DOM.
 */
async function dropFiles(zone: HTMLElement, files: File[]): Promise<void> {
  await act(async () => {
    fireEvent.drop(zone, { dataTransfer: { files, types: ['Files'] } });
  });
}

/** A bare zone over a spy, for the assertions the zone itself answers. */
function renderBareZone() {
  const onFiles = vi.fn<(files: File[]) => void>();
  const { container } = render(<DropZone onFiles={onFiles} />);
  return { container, onFiles, zone: zoneIn(container) };
}

/** The zone over the real queue, for the assertions the queue answers. */
function renderQueue() {
  const { container } = render(<QueueHarness />);
  return { container, zone: zoneIn(container) };
}

/**
 * The real zone over the real queue, rendering the two lists the upload surface renders.
 *
 * Rejection wording and thumbnail removal belong to the queue rather than to the zone, so proving
 * them needs a component that holds a queue. This is that component and nothing more: the class
 * names are the ones `client/src/styles.css` styles, and there is no text field and no submit
 * control, because neither is under test here. The thumbnail carries no preview image, since the
 * queued bytes have no object URL in jsdom; its name and its Remove control are what is asserted.
 */
function QueueHarness() {
  const queue = useImageQueue();

  return (
    <div>
      <DropZone onFiles={queue.addFiles} />
      {queue.rejections.length > 0 ? (
        <ul className="rejections">
          {queue.rejections.map((rejection) => (
            <li
              key={`${rejection.code}:${rejection.fileName}`}
              className="rejections__item"
              data-code={rejection.code}
            >
              {rejection.message}
            </li>
          ))}
        </ul>
      ) : null}
      {queue.entries.length > 0 ? (
        <ul className="thumbnail-list">
          {queue.entries.map((entry, index) => (
            <li key={`${entry.file.name}:${index}`} className="thumbnail">
              <span className="thumbnail__name">{entry.file.name}</span>
              {entry.note === undefined ? null : <p className="thumbnail__note">{entry.note}</p>}
              <button
                type="button"
                className="thumbnail__remove"
                aria-label={`Remove ${entry.file.name}`}
                onClick={() => queue.remove(index)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

describe('DropZone', () => {
  describe('the drop gesture', () => {
    it('hands every file of one drop to onFiles in the sequence the drop supplied them', () => {
      const { onFiles, zone } = renderBareZone();
      const first = pngFile('footprint-es-5m.png');
      const second = pngFile('gex-es-levels.png');

      fireEvent.drop(zone, { dataTransfer: { files: [first, second], types: ['Files'] } });

      expect(onFiles).toHaveBeenCalledTimes(1);
      const delivered = onFiles.mock.calls[0]?.[0] ?? [];
      expect(delivered.map((file) => file.name)).toEqual([first.name, second.name]);
    });

    it('cancels the dragover default, which is what makes the zone a drop target', () => {
      const { zone } = renderBareZone();
      const over = createEvent.dragOver(zone);

      fireEvent(zone, over);

      expect(over.defaultPrevented).toBe(true);
    });

    it('reports itself active from dragenter until dragleave', () => {
      const { zone } = renderBareZone();
      expect(zone).toHaveAttribute('data-drag-active', 'false');

      fireEvent.dragEnter(zone);
      expect(zone).toHaveAttribute('data-drag-active', 'true');

      fireEvent.dragLeave(zone);
      expect(zone).toHaveAttribute('data-drag-active', 'false');
    });

    it('ignores a drop and an activation while it is disabled', async () => {
      const user = userEvent.setup();
      const onFiles = vi.fn<(files: File[]) => void>();
      const { container } = render(<DropZone onFiles={onFiles} disabled />);
      const zone = zoneIn(container);
      const picker = vi.spyOn(HTMLInputElement.prototype, 'click');

      expect(zone).toHaveAttribute('aria-disabled', 'true');
      expect(zone).toHaveAttribute('tabindex', '-1');

      fireEvent.drop(zone, {
        dataTransfer: { files: [pngFile('footprint-es-5m.png')], types: ['Files'] },
      });
      await user.click(zone);

      expect(onFiles).not.toHaveBeenCalled();
      expect(picker).not.toHaveBeenCalled();
    });
  });

  describe('the file picker', () => {
    it('opens the picker exactly once for one click on the zone', async () => {
      const user = userEvent.setup();
      const { zone } = renderBareZone();
      const picker = vi.spyOn(HTMLInputElement.prototype, 'click');

      await user.click(zone);

      // Two calls would mean the input's own click bubbled back into the zone that opened it.
      expect(picker).toHaveBeenCalledTimes(1);
    });

    it('opens the picker on Enter, which reaches the zone by tabbing to it', async () => {
      const user = userEvent.setup();
      const { zone } = renderBareZone();
      const picker = vi.spyOn(HTMLInputElement.prototype, 'click');

      await user.tab();
      expect(zone).toHaveFocus();

      await user.keyboard('{Enter}');

      expect(picker).toHaveBeenCalled();
    });

    it('opens the picker on Space and cancels the key default', async () => {
      const user = userEvent.setup();
      const { zone } = renderBareZone();
      const picker = vi.spyOn(HTMLInputElement.prototype, 'click');

      zone.focus();
      await user.keyboard(' ');

      expect(picker).toHaveBeenCalled();

      // Space would scroll the page unless the handler cancels it.
      const spaceDown = createEvent.keyDown(zone, { key: ' ' });
      fireEvent(zone, spaceDown);
      expect(spaceDown.defaultPrevented).toBe(true);
    });

    it('queues the file chosen in the picker and clears the input afterwards', async () => {
      const user = userEvent.setup();
      const { container, onFiles } = renderBareZone();
      const input = fileInputIn(container);
      const file = pngFile('footprint-es-5m.png');

      await user.upload(input, file);

      expect(onFiles).toHaveBeenCalledTimes(1);
      const delivered = onFiles.mock.calls[0]?.[0] ?? [];
      expect(delivered.map((chosen) => chosen.name)).toEqual([file.name]);
      // Cleared after every selection: a retained value makes a second choice of the same
      // screenshot report no change at all, so it would never reach the queue.
      expect(input.value).toBe('');
    });

    it('clips the file input instead of removing it from rendering', () => {
      const { container } = renderBareZone();
      const input = fileInputIn(container);

      expect(input).toHaveClass('visually-hidden');
      expect(input.style.display).not.toBe('none');
    });

    it('exposes the zone as a labelled button in the tab sequence', () => {
      // The query itself proves the role and the accessible name; these are the rest of what
      // keeps the zone operable, and absent attributes are the enabled state.
      const { zone } = renderBareZone();

      expect(zone).toHaveAttribute('tabindex', '0');
      expect(zone).not.toHaveAttribute('aria-disabled');
    });
  });

  describe('over the real queue', () => {
    it('names a refused file and carries the shared sentence for its code', async () => {
      const { container, zone } = renderQueue();

      await dropFiles(zone, [new File(['x'], 'notes.pdf', { type: 'application/pdf' })]);

      const rejection = await findOrFail(container, '.rejections__item');
      expect(rejection).toHaveTextContent('notes.pdf');
      expect(rejection).toHaveTextContent(messageForCode('UNSUPPORTED_IMAGE_TYPE'));
      expect(rejection).toHaveAttribute('data-code', 'UNSUPPORTED_IMAGE_TYPE');
    });

    it('removes a queued screenshot when its Remove control is pressed with Enter', async () => {
      const user = userEvent.setup();
      const { container, zone } = renderQueue();
      const file = pngFile('footprint-es-5m.png');

      await dropFiles(zone, [file]);

      const thumbnail = await findOrFail(container, '.thumbnail');
      expect(thumbnail).toHaveTextContent(file.name);

      const remove = within(thumbnail).getByRole('button', { name: /remove/i });
      remove.focus();
      expect(remove).toHaveFocus();

      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(container.querySelector('.thumbnail')).toBeNull();
      });
    });

    it('queues the readable file of a mixed drop and reaches no network', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const { container, zone } = renderQueue();
      const readable = pngFile('gex-es-levels.png');
      const refused = new File(['x'], 'notes.pdf', { type: 'application/pdf' });

      await dropFiles(zone, [refused, readable]);

      const thumbnail = await findOrFail(container, '.thumbnail');
      expect(thumbnail).toHaveTextContent(readable.name);
      expect(container.querySelectorAll('.rejections__item')).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

