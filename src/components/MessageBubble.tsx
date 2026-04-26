import { useState, useEffect, useMemo } from "react";
import { User, Bot, CheckCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { parseThoughtQuestions, formatThoughtSubmission } from "@/lib/thoughtGuideQuestions";
import type { ChatMessage } from "@/lib/AppContext";

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
  const [selectedOptions, setSelectedOptions] = useState<Record<number, string>>({});

  useEffect(() => {
    setSelectedOptions({});
    setAnswers([]);
  }, [message.id]);

  const questions = useMemo(
    () =>
      thoughtGuideMode &&
      message.role === "assistant" &&
      !isSubmitted &&
      isLatestAssistant
        ? parseThoughtQuestions(message.content)
        : null,
    [thoughtGuideMode, message.role, message.content, isSubmitted, isLatestAssistant]
  );

  const hasQuestions = questions && questions.length > 0;

  const handleSelectOption = (idx: number, key: string, text: string) => {
    setSelectedOptions((prev) => ({ ...prev, [idx]: key }));
    if (key !== "other") {
      setAnswers((prev) => {
        const next = [...prev];
        next[idx] = `${key}. ${text}`;
        return next;
      });
    } else {
      setAnswers((prev) => {
        const next = [...prev];
        next[idx] = prev[idx] || "";
        return next;
      });
    }
  };

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
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-2 space-y-2">
              {message.attachments.map((att, i) =>
                att.mimeType.startsWith("image/") ? (
                  <img
                    key={i}
                    src={`data:${att.mimeType};base64,${att.data}`}
                    alt={att.filename}
                    className="max-w-full max-h-[300px] rounded-md object-contain"
                  />
                ) : (
                  <div key={i} className="text-xs opacity-80">
                    📎 {att.filename}
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* Thought Guidance Q&A Area */}
        {hasQuestions && (
          <div className="border border-amber-200 bg-amber-50 rounded-lg px-4 py-3 space-y-3">
            <p className="text-xs text-amber-700 font-medium">
              在此填写澄清回答（Ctrl / Cmd + Enter 可提交）
            </p>

            {questions!.map((q, idx) => {
              // 去重选项 key，防止 AI 重复输出同 key；
              // 同时过滤掉 AI 自己写的"其它"/"其他"选项，因为下方有专用的"其它"单选框 + 文本框。
              const uniqueOptions = q.options
                ? Array.from(new Map(q.options.map((o) => [o.key, o])).values()).filter(
                    (o) => {
                      const t = (o.text || "").trim();
                      return t !== "其它" && t !== "其他";
                    }
                  )
                : [];
              return (
              <div key={`${idx}-${q.number}`} className="space-y-1">
                <p className="text-xs text-amber-800 font-medium">
                  问题 {q.number}: {q.text}
                </p>
                {uniqueOptions.length > 0 ? (
                  <div className="space-y-1">
                    {uniqueOptions.map((opt) => {
                      const isSelected = selectedOptions[idx] === opt.key;
                      return (
                        <label
                          key={opt.key}
                          className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-0.5 transition-colors ${
                            isSelected ? "bg-amber-200/60 text-amber-800 font-medium" : "text-amber-900"
                          }`}
                        >
                          <input
                            type="radio"
                            name={`q-${q.number}-${idx}`}
                            value={opt.key}
                            checked={isSelected}
                            onChange={() => handleSelectOption(idx, opt.key, opt.text)}
                            className="accent-amber-600"
                          />
                          <span className="text-xs">
                            {opt.key}. {opt.text}
                          </span>
                        </label>
                      );
                    })}
                    <label
                      className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-0.5 transition-colors ${
                        selectedOptions[idx] === "other" ? "bg-amber-200/60 text-amber-800 font-medium" : "text-amber-900"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`q-${q.number}-${idx}`}
                        value="other"
                        checked={selectedOptions[idx] === "other"}
                        onChange={() => handleSelectOption(idx, "other", "")}
                        className="accent-amber-600"
                      />
                      <span className="text-xs">其它</span>
                    </label>
                    {selectedOptions[idx] === "other" && (
                      <textarea
                        value={answers[idx] || ""}
                        onChange={(e) => handleAnswerChange(idx, e.target.value)}
                        onKeyDown={(e) => handleKeyDown(e, idx)}
                        placeholder={`填写问题 ${q.number} 的其它回答...`}
                        className="w-full min-h-[48px] px-2 py-1 text-xs rounded border border-amber-200 bg-white resize-none outline-none focus:border-amber-400"
                        rows={2}
                      />
                    )}
                  </div>
                ) : (
                  <textarea
                    value={answers[idx] || ""}
                    onChange={(e) => handleAnswerChange(idx, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, idx)}
                    placeholder={`填写问题 ${q.number} 的回答...`}
                    className="w-full min-h-[48px] px-2 py-1 text-xs rounded border border-amber-200 bg-white resize-none outline-none focus:border-amber-400"
                    rows={2}
                  />
                )}
              </div>
            );})}

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
