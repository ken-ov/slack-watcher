import { handleCodeRequest } from "./code-request.js";
import { handlePrReview } from "./pr-review.js";
import { handleQuestion } from "./question.js";
import { handleNeedsClarification } from "./clarification.js";

// Classification kind → handler. Kinds with no entry (e.g. "ignore") are logged but not acted on.
export const HANDLERS = {
  code_request: handleCodeRequest,
  pr_review: handlePrReview,
  question: handleQuestion,
  needs_clarification: handleNeedsClarification,
};
