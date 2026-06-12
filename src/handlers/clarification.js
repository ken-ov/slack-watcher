export async function handleNeedsClarification(ctx) {
  const { mention, classification, slack, selfId } = ctx;
  const questions = (classification.questions ?? []).map((q) => `• ${q}`).join("\n");
  await slack.postToSelf(
    selfId,
    `:grey_question: Mention looks like a request but is too vague to act on: ${mention.permalink ?? "n/a"}\n> ${classification.summary}\n\nSuggested questions to send back to @${mention.username ?? mention.user}:\n${questions || "• (classifier returned no questions — ask them to describe expected behavior and where it happens)"}`,
  );
  return { status: "clarification_requested" };
}
