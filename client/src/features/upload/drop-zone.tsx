import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent, MouseEvent } from "react";

import { ACCEPTED_IMAGE_MIME_TYPES } from "@trade-read/shared";

/**
 * The drop target and the file picker are two equal ways into the same queue: the zone is a
 * focusable button, a click or Enter or Space opens the operating-system picker, and one drop
 * hands over every file of the gesture in a single call. This component validates nothing and
 * sends nothing — the queue behind `onFiles` decides what a file is and what to tell the
 * operator about it.
 */
export interface DropZoneProps {
  /** Every file of one gesture, in the order the drop or the selection supplied them. */
  onFiles: (files: File[]) => void;
  /** Announced but inert: leaves the tab order and opens no picker. */
  disabled?: boolean;
}

const ZONE_LABEL =
  "Add chart screenshots: drop files here, or press Enter or Space to choose files.";

export default function DropZone({ onFiles, disabled = false }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Counts the dragenter/dragleave pairs one drag produces while it crosses this zone's child
   * elements, so the active state turns off only once the pointer has left the zone as a whole.
   */
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  // Derived rather than stored, so a zone disabled mid-drag cannot be left carrying a highlight.
  const isDragActive = dragActive && !disabled;

  const openPicker = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const handleClick = useCallback(() => {
    openPicker();
  }, [openPicker]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      // Space would otherwise scroll the page and Enter would otherwise fire the zone's own
      // click a second time.
      event.preventDefault();
      openPicker();
    },
    [disabled, openPicker],
  );

  /**
   * The picker's programmatic click bubbles back into the zone's click handler, which opens the
   * picker again — without end. The input stops it at the source, and this guard is what keeps
   * one operator action to one click.
   */
  const handleInputClick = useCallback((event: MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.currentTarget.files ?? []);
      // Clearing the value before handing the files over lets the same file be chosen twice in a
      // row; a retained value makes the second selection report no change at all.
      event.currentTarget.value = "";
      if (selected.length > 0) onFiles(selected);
    },
    [onFiles],
  );

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (disabled) return;
      dragDepth.current += 1;
      setDragActive(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // Cancelling dragover is what marks this element as a drop target: without it the browser
      // refuses the drop outright and `onDrop` never fires.
      event.preventDefault();
      if (disabled) return;
      setDragActive(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (disabled) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    },
    [disabled],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setDragActive(false);
      if (disabled) return;
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (dropped.length > 0) onFiles(dropped);
    },
    [disabled, onFiles],
  );

  return (
    <div
      className={isDragActive ? "drop-zone drop-zone--active" : "drop-zone"}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={ZONE_LABEL}
      aria-disabled={disabled ? true : undefined}
      data-drag-active={isDragActive ? "true" : "false"}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <p className="drop-zone__title">Add chart screenshots</p>
      <p className="drop-zone__hint">
        Drag and drop your screenshots here, or click to choose them from your device. Several
        screenshots can be added in one go.
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_IMAGE_MIME_TYPES.join(",")}
        className="drop-zone__input visually-hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={handleInputChange}
        onClick={handleInputClick}
      />
    </div>
  );
}
