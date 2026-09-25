"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, CircleAlert, Mail } from "lucide-react";
import { requestCode, verifyCode } from "@/app/actions/auth";
import { Spinner } from "@/components/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { OtpInput } from "@/components/ui/otp-input";

export function LoginForm({ oauthQuery = "" }: { oauthQuery?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeGeneration, setCodeGeneration] = useState(0);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [operation, setOperation] = useState<"send" | "verify">("send");
  const [pending, startTransition] = useTransition();
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pending) return;
    if (step === "code") codeRef.current?.querySelector("input")?.focus();
    else emailRef.current?.focus();
  }, [step, pending]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function sendCode() {
    setError("");
    setNotice("");
    setOperation("send");
    startTransition(async () => {
      try {
        const normalizedEmail = email.trim().toLowerCase();
        const result = await requestCode(normalizedEmail);
        if (!result.success) {
          setError(result.error);
          return;
        }
        setEmail(normalizedEmail);
        setCode("");
        setCodeGeneration((generation) => generation + 1);
        setVerified(false);
        setCooldown(60);
        setStep("code");
        setNotice("Code sent. Check your inbox and spam folder.");
      } catch {
        setError("We couldn't connect. Check your connection and try again.");
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (step === "email") {
      sendCode();
      return;
    }
    if (!/^\d{6}$/.test(code)) return;
    setError("");
    setNotice("");
    setOperation("verify");
    startTransition(async () => {
      try {
        const result = await verifyCode(email, code, oauthQuery);
        if (!result.success) {
          setError(result.error);
          return;
        }
        setVerified(true);
        if (result.data.redirectUrl) window.location.assign(result.data.redirectUrl);
        else {
          router.replace("/");
          router.refresh();
        }
      } catch {
        setError("We couldn't connect. Check your connection and try again.");
      }
    });
  }

  return (
    <Card className="w-full max-w-md rounded-xl shadow-[0_2px_8px_rgb(0_0_0/.05)] [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(6)]">
      <CardHeader className="gap-3">
        <CardTitle>
          <h2>{step === "email" ? "Sign in to Orole Drive" : "Check your inbox"}</h2>
        </CardTitle>
        <CardDescription>
          {step === "email"
            ? "We’ll email you a sign-in code. No password needed."
            : <>Enter the six-digit code sent to <span className="break-all font-medium text-foreground">{email}</span>.</>}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form id="family-login" onSubmit={submit} aria-busy={pending}>
          <FieldGroup>
            {step === "email" ? (
              <Field data-invalid={Boolean(error)} data-disabled={pending}>
                <FieldLabel htmlFor="family-email">Family email</FieldLabel>
                <Input
                  ref={emailRef}
                  id="family-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="you@orole.be"
                  required
                  maxLength={254}
                  disabled={pending}
                  value={email}
                  onChange={(event) => { setEmail(event.target.value); setError(""); }}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "email-help login-error" : "email-help"}
                  className="h-12"
                />
                <FieldDescription id="email-help">Only @orole.be email addresses can sign in.</FieldDescription>
              </Field>
            ) : (
              <Field data-invalid={Boolean(error)} data-disabled={pending}>
                <FieldLabel id="code-label" htmlFor="family-code-0">Sign-in code</FieldLabel>
                <OtpInput
                  key={codeGeneration}
                  ref={codeRef}
                  id="family-code"
                  role="group"
                  aria-labelledby="code-label"
                  length={6}
                  size="md"
                  type="numbers"
                  autoFocus
                  disabled={pending}
                  status={error ? "error" : verified ? "success" : "idle"}
                  onChange={(nextCode) => { setCode(nextCode); setError(""); setVerified(false); }}
                  aria-describedby={error ? "code-help login-error" : "code-help"}
                  className="w-full"
                />
                <FieldDescription id="code-help">Your code expires in 10 minutes. Use the most recent one.</FieldDescription>
              </Field>
            )}
            {error && (
              <Alert variant="destructive" id="login-error">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" disabled={pending || (step === "code" && code.length !== 6)} className="h-12 w-full">
              {pending ? <><span aria-hidden="true" className="inline-flex items-center justify-center"><Spinner /></span>{operation === "send" ? "Sending code…" : "Signing in…"}</> : <>{step === "email" ? "Send sign-in code" : oauthQuery ? "Continue to authorization" : "Open my drive"}<ArrowRight data-icon="inline-end" aria-hidden="true" /></>}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3">
        {step === "code" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" type="button" disabled={pending} onClick={() => { setStep("email"); setCode(""); setError(""); setNotice(""); }}>
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />Change email
              </Button>
              <Button variant="ghost" type="button" disabled={pending || cooldown > 0} onClick={sendCode}>
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Send a new code"}
              </Button>
            </div>
            <p role="status" className="min-h-5 text-center text-xs text-muted-foreground">{notice}</p>
          </>
        ) : (
          <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Mail className="size-3.5 shrink-0" aria-hidden="true" />Use your @orole.be email.
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
