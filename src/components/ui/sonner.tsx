"use client"

import type { CSSProperties } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { Check, InfoIcon, TriangleAlertIcon, CircleAlert } from "lucide-react"
import { Spinner } from "@/components/spinner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <Check className="size-4 text-primary" />
        ),
        info: (
          <InfoIcon className="size-4 text-primary" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4 text-destructive" />
        ),
        error: (
          <CircleAlert className="size-4 text-destructive" />
        ),
        loading: (
          <Spinner size={16} />
        ),
      }}
      offset={16}
      mobileOffset={16}
      style={{ "--width": "24rem", fontFamily: "var(--font-sans)" } as CSSProperties}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "notification-surface flex min-h-14 w-full items-center gap-2 py-3 pl-4 pr-14 text-sm",
          content: "flex min-w-0 flex-1 flex-col gap-1",
          title: "font-medium leading-5",
          description: "text-xs text-muted-foreground!",
          icon: "flex size-4 shrink-0 items-center justify-center",
          closeButton: "absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md bg-transparent! text-foreground! transition-colors hover:bg-accent! [&>svg]:size-4",
          actionButton: "shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground",
          cancelButton: "shrink-0 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
