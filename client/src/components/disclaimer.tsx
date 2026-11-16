import { DISCLAIMER } from '@trade-read/shared';

/**
 * The fixed disclaimer every surface that shows a recommendation renders.
 *
 * The sentence is owned by the shared limits module and rendered here unchanged, which is what
 * keeps the persisted analysis document and the interface in agreement. The element carries no
 * other content, so its text is exactly the shared constant.
 */
export function Disclaimer() {
  return (
    <p className="disclaimer" role="note">
      {DISCLAIMER}
    </p>
  );
}
