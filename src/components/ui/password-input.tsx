import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<React.ComponentProps<"input">, "type">;

/**
 * A password box with our own show/hide eye that always stays.
 *
 * Edge draws its own eye only while a password is being typed and removes it for good once the box
 * loses focus, so people saw the eye, typed, and then could not check what they typed. That native
 * eye is hidden in styles.css so only this one shows.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, disabled, ...props }, forwardedRef) => {
    const { t } = useLanguage();
    const [visible, setVisible] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const caret = React.useRef<{ start: number; end: number } | null>(null);

    const setRefs = React.useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    // Switching the type can move the caret to the start; put it back where the person was typing.
    React.useLayoutEffect(() => {
      const input = inputRef.current;
      const saved = caret.current;
      caret.current = null;
      if (!input || !saved || document.activeElement !== input) return;
      // Chrome rebuilds the box for the new type at its next layout and puts the caret at the start
      // then, undoing a caret set before it. Reading the width runs that layout now.
      void input.offsetWidth;
      input.setSelectionRange(saved.start, saved.end);
    }, [visible]);

    const toggle = () => {
      const input = inputRef.current;
      if (input && document.activeElement === input) {
        caret.current = {
          start: input.selectionStart ?? input.value.length,
          end: input.selectionEnd ?? input.value.length,
        };
      }
      setVisible((shown) => !shown);
    };

    const label = visible ? t("Hide password") : t("Show password");

    return (
      <span className="relative block">
        <Input
          ref={setRefs}
          type={visible ? "text" : "password"}
          disabled={disabled}
          // Shown as plain text, phone keyboards would otherwise capitalise or "correct" the password.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cn("pr-11", className)}
          {...props}
        />
        <button
          type="button"
          data-no-translate
          disabled={disabled}
          aria-label={label}
          title={label}
          aria-pressed={visible}
          // Keep the focus (and the phone keyboard) in the password box.
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggle}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-slate transition-colors hover:text-navy focus-visible:text-navy focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {visible ? (
            <EyeOff className="h-[18px] w-[18px]" aria-hidden />
          ) : (
            <Eye className="h-[18px] w-[18px]" aria-hidden />
          )}
        </button>
      </span>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
