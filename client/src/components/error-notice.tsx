import type { ErrorCode } from '@trade-read/shared';

import { messageForCode, shouldOfferResubmit } from '../api/errors';

/**
 * The props a failure surface passes: the code the server answered with, an optional sentence that
 * replaces the code's own, and the control that re-posts the same request.
 *
 * `code` is required because it is the only input the interface has for choosing what to show.
 * `message` is supplied when a sentence that is more specific than the code's own must be shown
 * unchanged — a per-file rejection names the file it refused and belongs beside the queued images.
 * `onResubmit` is supplied only by a surface that still holds the request it could send again.
 */
export interface ErrorNoticeProps {
  code: ErrorCode;
  message?: string;
  onResubmit?: () => void;
}

/**
 * The client's single failure surface: the sentence for an error code, and the control that
 * retries the request it refused.
 *
 * Both decisions come from `api/errors`: the text through `messageForCode`, so no sentence is
 * written twice, and whether a retry is offered through `shouldOfferResubmit`, so `NOT_FOUND` — the
 * one code a retry cannot recover — never shows a control even when a caller passes one. A
 * supplied `message` wins over the code's own sentence because it carries detail this component
 * cannot derive, such as the name of the file that failed validation.
 *
 * This component deliberately renders no pending state: a surface replaces its spinner with this
 * notice, so a failure is never shown as progress. It holds no state, starts no request and owns
 * no queue — the caller's `onResubmit` re-posts what it already has. The whole notice is an
 * `alert` region, so a keyboard or screen-reader user hears the failure when it replaces that
 * pending state, and `data-code` exposes the code as markup because the stylesheet is not loaded
 * in the test environment.
 */
export default function ErrorNotice({ code, message, onResubmit }: ErrorNoticeProps) {
  const text = message !== undefined && message !== '' ? message : messageForCode(code);
  const canResubmit = onResubmit !== undefined && shouldOfferResubmit(code);

  return (
    <div className="error-notice" role="alert" data-code={code}>
      <p className="error-notice__message">{text}</p>
      {canResubmit ? (
        <div className="error-notice__actions">
          <button type="button" className="button" onClick={onResubmit}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
