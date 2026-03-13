const NON_INTERACTIVE_ANSWER = "This is a non-interactive session. Operator input is unavailable.";
const MAX_SUMMARY_LENGTH = 220;

type UserInputOption = {
  label: string;
};

type UserInputQuestion = {
  id: string;
  header: string | null;
  question: string | null;
  options: UserInputOption[];
};

export interface AutoUserInputResult {
  answers: Record<string, { answers: string[] }>;
  kind: "approval_auto_approved" | "user_input_auto_answered";
  summary: string;
}

export function buildAutoUserInputResult(
  params: Record<string, unknown>,
  options: { autoApproveRequests: boolean }
): AutoUserInputResult | null {
  const questions = parseQuestions(params);
  if (questions.length === 0) {
    return null;
  }

  if (options.autoApproveRequests) {
    const approvalAnswers = buildApprovalAnswers(questions);
    if (approvalAnswers) {
      return {
        answers: approvalAnswers,
        kind: "approval_auto_approved",
        summary: truncateSummary(`Auto-approved user-input request: ${summarizeQuestionLabels(questions)} -> Approve this Session`)
      };
    }
  }

  const answers: Record<string, { answers: string[] }> = {};
  const summaryParts: string[] = [];

  for (const [index, question] of questions.entries()) {
    const key = question.id.trim().length > 0 ? question.id : `question_${index + 1}`;
    answers[key] = { answers: [NON_INTERACTIVE_ANSWER] };
    summaryParts.push(`${questionLabel(question, index)} -> ${NON_INTERACTIVE_ANSWER}`);
  }

  return {
    answers,
    kind: "user_input_auto_answered",
    summary: truncateSummary(`Auto-answered user-input request: ${summaryParts.join("; ")}`)
  };
}

function parseQuestions(params: Record<string, unknown>): UserInputQuestion[] {
  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];

  return rawQuestions.flatMap((value, index) => {
    if (!value || typeof value !== "object") {
      return [];
    }

    const question = value as Record<string, unknown>;
    const id = asString(question.id) ?? `question_${index + 1}`;
    const header = asString(question.header);
    const prompt = asString(question.question);
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!option || typeof option !== "object") {
            return [];
          }

          const label = asString((option as Record<string, unknown>).label);
          return label ? [{ label }] : [];
        })
      : [];

    return [
      {
        id,
        header,
        question: prompt,
        options
      }
    ];
  });
}

export function summarizeUserInputRequest(params: Record<string, unknown>): string {
  const directQuestion = asString(params.question) ?? asString(params.prompt);
  if (directQuestion && directQuestion.trim().length > 0) {
    return `Tool requires user input: ${truncateSummary(directQuestion.trim(), 120)}`;
  }

  const questions = parseQuestions(params);
  if (questions.length === 0) {
    return "Tool requires user input";
  }

  return truncateSummary(`Tool requires user input: ${summarizeQuestionLabels(questions)}`);
}

function questionLabel(question: UserInputQuestion, index: number): string {
  if (question.header && question.header.trim().length > 0) {
    return question.header.trim();
  }

  if (question.question && question.question.trim().length > 0) {
    return truncateSummary(question.question.trim(), 80);
  }

  if (question.id.trim().length > 0) {
    return question.id.trim();
  }

  return `question ${index + 1}`;
}

function summarizeQuestionLabels(questions: UserInputQuestion[]): string {
  return questions.map(questionLabel).join("; ");
}

function buildApprovalAnswers(questions: UserInputQuestion[]): Record<string, { answers: string[] }> | null {
  const answers: Record<string, { answers: string[] }> = {};

  for (const question of questions) {
    const answer = approvalAnswerLabel(question.options);
    if (!answer) {
      return null;
    }

    answers[question.id] = {
      answers: [answer]
    };
  }

  return Object.keys(answers).length > 0 ? answers : null;
}

function approvalAnswerLabel(options: UserInputOption[]): string | null {
  const labels = options.map((option) => option.label);

  return (
    labels.find((label) => label === "Approve this Session") ??
    labels.find((label) => label === "Approve Once") ??
    labels.find((label) => approvalOptionLabel(label)) ??
    null
  );
}

function approvalOptionLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized.startsWith("approve") || normalized.startsWith("allow");
}

function truncateSummary(input: string, maxLength = MAX_SUMMARY_LENGTH): string {
  if (input.length <= maxLength) {
    return input;
  }

  return `${input.slice(0, Math.max(0, maxLength - 3))}...`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
