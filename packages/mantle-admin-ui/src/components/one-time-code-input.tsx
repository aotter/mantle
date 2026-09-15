import { REGEXP_ONLY_DIGITS } from "input-otp";
import type { ComponentProps } from "react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

export function OneTimeCodeInput(
  props: Omit<
    ComponentProps<typeof InputOTP>,
    "children" | "maxLength" | "minLength" | "pattern" | "render"
  >,
) {
  return (
    <InputOTP
      aria-label="One-time code"
      containerClassName="justify-center"
      maxLength={6}
      minLength={6}
      pattern={REGEXP_ONLY_DIGITS}
      {...props}
    >
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
        <InputOTPSlot index={3} />
        <InputOTPSlot index={4} />
        <InputOTPSlot index={5} />
      </InputOTPGroup>
    </InputOTP>
  );
}
