import { useState } from "react";
import { User, Bot, CheckCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { parseThoughtQuestions, formatThoughtSubmission } from "@/lib/thoughtGuideQuestions";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  durationMs?: number;
}

interface MessageBubbleProps {
  message: ChatMessage;
  thoughtGuideMode: boolean;
  isSubmitted: boolean;
  onSubmitAnswers: (formattedText: string) => void;
  isLatestAssistant: boolean;
}

export default function MessageBubble({
  message,
  thoughtGuideMode,
  isSubmitted,
  onSubmitAnswers,
  isLatestAssistant,
}: MessageBubbleProps) {
  const [answers, setAnswers] = useState<string[]>([]);
  const questions =
    thoughtGuideMode &&
    message.role === "assistant" &&
    !isSubmitted &&
    isLatestAssistant
      ? parseThoughtQuestions(message.content)
      : null;

  const hasQuestions = questions && questions.length > 0;

  const handleAnswerChange = (index: number, value: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleSubmit = () => {
    const formatted = formatThoughtSubmission(answers, "");
    if (formatted) {
      onSubmitAnswers(formatted);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, _index: number) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      className={`flex gap-3 ${
        message.role === "user" ? "flex-row-reverse" : ""
      }`}
    >
      <div
        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          message.role === "user"
            ? "bg-blue-100 text-blue-600"
            : "bg-emerald-100 text-emerald-600"
        }`}
      >
        {message.role === "user" ? (
          <User className="h-4 w-4" />
        ) : (
          <Bot className="h-4 w-4" />
        )}
      </div>

      <div className={`max-w-[80%] space-y-2 ${message.role === "user" ? "items-end" : ""}`}>
        {message.timestamp && (
          <div className={`text-[10px] text-slate-400 ${message.role === "user" ? "text-right" : "text-left"}`}>
            {message.timestamp}
            {message.role === "assistant" && message.durationMs !== undefined && (
              <span className="ml-1 text-slate-400">({(message.durationMs / 1000).toFixed(1)}s)</span>
            )}
          </div>
        )}
        <div
          className={`rounded-lg px-4 py-2 text-sm leading-relaxed ${
            message.role === "user"
              ? "bg-blue-600 text-white"
              : "bg-slate-100 text-slate-800"
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <Badge
              variant={message.role === "user" ? "secondary" : "outline"}
              className="text-[10px] h-4"
            >
              {message.role === "user" ? "你" : "AI 助手"}
            </Badge>
            {isSubmitted && message.role === "assistant" && (
              <Badge variant="secondary" className="text-[10px] h-4">
                <CheckCircle className="h-3 w-3 mr-1" />
                已回答
              </Badge>
            )}
          </div>
          <div className="whitespace-pre-wrap break-words overflow-hidden">{message.content}</div>
        </div>

        {/* Thought Guidance Q&A Area */}
        {hasQuestions && (
          <div className="border border-amber-200 bg-amber-50 rounded-lg px-4 py-3 space-y-3">
            <p className="text-xs text-amber-700 font-medium">
              在此填写澄清回答（Ctrl / Cmd + Enter 可提交）
            </p>

            {questions!.map((q, idx) => (
              <div key={q.number} className="space-y-1">
                <p className="text-xs text-amber-800 font-medium">
                  问题 {q.number}: {q.text}
                </p>
                <textarea
                  value={answers[idx] || ""}
                  onChange={(e) => handleAnswerChange(idx, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, idx)}
                  placeholder={`填写问题 ${q.number} 的回答...`}
                  className="w-full min-h-[48px] px-2 py-1 text-xs rounded border border-amber-200 bg-white resize-none outline-none focus:border-amber-400"
                  rows={2}
                />
              </div>
            ))}

            <Button
              size="sm"
              className="w-full bg-amber-600 hover:bg-amber-700 text-white"
              onClick={handleSubmit}
            >
              一键提交回答
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
