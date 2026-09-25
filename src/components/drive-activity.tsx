"use client";

import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { History, TriangleAlert } from "lucide-react";
import { listActivity, listActivityMembers } from "@/lib/drive-read-client";
import type {
  DriveActivityAction,
  DriveActivityEvent,
  DriveItem,
} from "@/lib/drive-types";
import { formatBytes } from "@/lib/format-bytes";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/spinner";
import { Hint } from "@/components/hint";
import { useFolderAccess } from "@/components/folder-access";
import { profileAvatarUrl } from "@/lib/profile-avatar";

/** Where an activity entry leads: an item to open or preview, or a folder (in Trash when `trash`). */
export type ActivityTarget =
  | { item: DriveItem }
  | { folderId: string | null; trash: boolean };

const actionGroups: {
  value: string;
  label: string;
  actions: DriveActivityAction[];
}[] = [
  { value: "uploads", label: "Uploads", actions: ["upload", "new_version"] },
  { value: "folders", label: "New folders", actions: ["create_folder"] },
  { value: "renames", label: "Renames", actions: ["rename"] },
  { value: "moves", label: "Moves and copies", actions: ["move", "copy"] },
  {
    value: "trash",
    label: "Trash and deletions",
    actions: ["trash", "restore", "delete", "empty_trash"],
  },
  { value: "sharing", label: "Public links", actions: ["share", "unshare"] },
  {
    value: "versions",
    label: "Versions",
    actions: ["new_version", "restore_version", "delete_version"],
  },
  {
    value: "passwords",
    label: "Folder passwords",
    actions: ["protect", "unprotect"],
  },
  {
    value: "search",
    label: "AI search",
    actions: ["exclude_search", "include_search"],
  },
];

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function relativeTime(at: string, now: number): string {
  const seconds = Math.round((new Date(at).getTime() - now) / 1000);
  if (seconds > -45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes > -60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relative.format(hours, "hour");
  return new Date(at).toLocaleTimeString("en", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function dayLabel(at: string, now: number): string {
  const day = new Date(at).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return new Date(at).toLocaleDateString("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year:
      new Date(at).getFullYear() === new Date(now).getFullYear()
        ? undefined
        : "numeric",
  });
}

function Link({
  label,
  onClick,
  className,
}: {
  label: string;
  onClick?: () => void;
  className?: string;
}) {
  if (!onClick)
    return (
      <span className={cn("font-medium text-foreground", className)}>
        {label}
      </span>
    );
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {label}
    </button>
  );
}

/** "moved report.pdf from Taxes to Archive", with the item and folders linked when they can be opened. */
function ActivitySentence({
  event,
  onOpen,
}: {
  event: DriveActivityEvent;
  onOpen?: (target: ActivityTarget) => void;
}) {
  const { item, details, parent } = event;
  const openItem =
    !onOpen || item.redacted
      ? undefined
      : event.current
        ? () => onOpen({ item: event.current! })
        : item.status === "trashed"
          ? () => onOpen({ folderId: null, trash: true })
          : undefined;
  const name = (
    <Link
      label={item.name}
      onClick={openItem}
      className={cn(
        item.redacted && "font-normal italic text-muted-foreground",
      )}
    />
  );
  const folder = (label: string | null | undefined) => label ?? "All files";
  const openParent =
    onOpen && parent
      ? () => onOpen({ folderId: parent.id, trash: parent.trashed })
      : undefined;
  const into = parent ? (
    <>
      {" "}
      in <Link label={parent.name} onClick={openParent} />
    </>
  ) : null;
  const to = parent ? (
    <>
      {" "}
      to <Link label={parent.name} onClick={openParent} />
    </>
  ) : null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  let sentence: ReactNode;
  switch (event.action) {
    case "upload":
      sentence = (
        <>
          uploaded {name}
          {into}
        </>
      );
      break;
    case "create_folder":
      sentence = (
        <>
          created the folder {name}
          {into}
        </>
      );
      break;
    case "rename":
      sentence = (
        <>
          renamed{" "}
          {text(details.fromName) ? (
            <span className="font-medium text-foreground">
              {text(details.fromName)}
            </span>
          ) : (
            "an item"
          )}{" "}
          to {name}
        </>
      );
      break;
    case "move":
      sentence = (
        <>
          moved {name}
          {"fromParentName" in details && (
            <>
              {" "}
              from{" "}
              <span className="font-medium text-foreground">
                {folder(text(details.fromParentName))}
              </span>
            </>
          )}
          {parent
            ? to
            : "toParentName" in details && (
                <>
                  {" "}
                  to{" "}
                  <span className="font-medium text-foreground">
                    {folder(text(details.toParentName))}
                  </span>
                </>
              )}
        </>
      );
      break;
    case "copy":
      sentence = (
        <>
          copied {name}
          {to}
        </>
      );
      break;
    case "trash":
      sentence = (
        <>
          moved {name} to Trash{details.reason === "replaced" && " (replaced)"}
        </>
      );
      break;
    case "restore":
      sentence = (
        <>
          restored {name}
          {details.restoredToRoot ? " to All files" : into}
        </>
      );
      break;
    case "delete":
      sentence =
        details.reason === "expired" ? (
          <>permanently deleted {name} after 30 days in Trash</>
        ) : (
          <>permanently deleted {name}</>
        );
      break;
    case "empty_trash":
      sentence = (
        <>
          emptied Trash
          {typeof details.count === "number" &&
            ` (${details.count} ${details.count === 1 ? "item" : "items"}${typeof details.bytes === "number" ? `, ${formatBytes(details.bytes)}` : ""})`}
        </>
      );
      break;
    case "share":
      sentence = <>shared {name} with a public link</>;
      break;
    case "unshare":
      sentence = <>turned off the public link for {name}</>;
      break;
    case "new_version":
      sentence = <>uploaded a new version of {name}</>;
      break;
    case "restore_version":
      sentence = <>restored an earlier version of {name}</>;
      break;
    case "delete_version":
      sentence = <>deleted an old version of {name}</>;
      break;
    case "protect":
      sentence = details.passwordChanged ? (
        <>changed the password of {name}</>
      ) : (
        <>protected {name} with a password</>
      );
      break;
    case "unprotect":
      sentence = <>removed the password from {name}</>;
      break;
    case "exclude_search":
      sentence = <>excluded {name} from AI search</>;
      break;
    case "include_search":
      sentence = <>included {name} in AI search again</>;
      break;
  }
  return (
    <>
      <span className="font-medium text-foreground">{event.actor.name}</span>{" "}
      {sentence}
    </>
  );
}

function ActivityTime({ at, now }: { at: string; now: number }) {
  return (
    <Hint
      label={new Date(at).toLocaleString("en", {
        dateStyle: "full",
        timeStyle: "short",
      })}
    >
      <time
        dateTime={at}
        className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
      >
        {relativeTime(at, now)}
      </time>
    </Hint>
  );
}

function ActorAvatar({
  actor,
  className,
}: {
  actor: { name: string; email: string | null };
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      {/* DiceBear generates this data URI client-side; Next image optimization cannot process it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={profileAvatarUrl(actor)} alt="" className="size-full" />
    </span>
  );
}

/** The family's shared history: a day-grouped timeline with member and action filters. */
export function DriveActivityView({
  onOpen,
}: {
  onOpen: (target: ActivityTarget) => void;
}) {
  const { run } = useFolderAccess();
  const [actorId, setActorId] = useState("all");
  const [group, setGroup] = useState("all");
  const actions = actionGroups.find((entry) => entry.value === group)?.actions;
  const members = useQuery({
    queryKey: ["drive-activity-members"],
    queryFn: ({ signal }) => run(() => listActivityMembers(signal)),
    staleTime: 5 * 60_000,
  });
  const feed = useInfiniteQuery({
    queryKey: ["drive-activity", actorId, group],
    queryFn: ({ pageParam, signal }) =>
      run(() =>
        listActivity({
          cursor: pageParam,
          actorId: actorId === "all" ? undefined : actorId,
          actions,
        }, signal),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 15_000,
  });
  const [now] = useState(() => Date.now());
  const events = feed.data?.pages.flatMap((page) => page.events) ?? [];
  const days: { label: string; events: DriveActivityEvent[] }[] = [];
  for (const event of events) {
    const label = dayLabel(event.at, now);
    if (days.at(-1)?.label === label) days.at(-1)!.events.push(event);
    else days.push({ label, events: [event] });
  }
  const memberItems = [
    { value: "all", label: "Everyone" },
    ...(members.data ?? []).map((member) => ({
      value: member.id,
      label: member.name,
    })),
  ];
  const groupItems = [{ value: "all", label: "All activity" }, ...actionGroups];
  const filtered = actorId !== "all" || group !== "all";

  return (
    <div className="flex flex-1 flex-col">
      <section
        aria-label="Activity filters"
        className="mb-5 flex flex-wrap items-center gap-2"
      >
        <Select
          value={actorId}
          items={memberItems}
          onValueChange={(value) => {
            if (value) setActorId(value);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Filter by member"
            className="w-auto min-w-36"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {memberItems.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={group}
          items={groupItems}
          onValueChange={(value) => {
            if (value) setGroup(value);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Filter by type of change"
            className="w-auto min-w-36"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {groupItems.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setActorId("all");
              setGroup("all");
            }}
          >
            Clear
          </Button>
        )}
      </section>
      <div
        aria-live="polite"
        role="status"
        className="mb-3 flex min-h-5 items-center gap-2 text-xs text-muted-foreground"
      >
        {feed.isFetching && !feed.isFetchingNextPage && (
          <>
            <Spinner size={12} />
            {feed.data ? "Updating activity…" : "Loading activity…"}
          </>
        )}
      </div>
      {feed.isPending ? (
        <div aria-label="Loading activity" className="flex flex-col gap-5 py-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-3/5" />
                <Skeleton className="h-2 w-1/5" />
              </div>
            </div>
          ))}
        </div>
      ) : feed.error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>We couldn’t load the activity</AlertTitle>
          <AlertDescription>
            <p>{feed.error.message}</p>
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void feed.refetch()}
              >
                Try again
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : !events.length ? (
        <Empty className="mx-auto my-auto w-full max-w-md border-0 px-0 py-12">
          <EmptyHeader>
            <EmptyMedia>
              <History
                className="size-10 text-muted-foreground"
                strokeWidth={1.2}
              />
            </EmptyMedia>
            <EmptyTitle>
              {filtered ? "No matching activity" : "No activity yet"}
            </EmptyTitle>
            <EmptyDescription>
              {filtered
                ? "Try another member or type of change."
                : "Uploads, moves, renames and deletions by your family will show up here."}
            </EmptyDescription>
          </EmptyHeader>
          {filtered && (
            <EmptyContent>
              <Button
                variant="outline"
                onClick={() => {
                  setActorId("all");
                  setGroup("all");
                }}
              >
                Clear filters
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="flex flex-col gap-7">
          {days.map((day) => (
            <section key={day.label} aria-label={day.label}>
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">
                {day.label}
              </h2>
              <ol className="flex flex-col">
                {day.events.map((event) => (
                  <li
                    key={event.id}
                    className="flex items-start gap-3 border-b border-border/50 py-3 last:border-b-0"
                  >
                    <ActorAvatar actor={event.actor} />
                    <div className="min-w-0 flex-1 pt-1.5">
                      <p className="break-words text-sm leading-snug text-muted-foreground">
                        <ActivitySentence event={event} onOpen={onOpen} />
                      </p>
                    </div>
                    <div className="pt-1.5">
                      <ActivityTime at={event.at} now={now} />
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {feed.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={feed.isFetchingNextPage}
                onClick={() => void feed.fetchNextPage()}
              >
                {feed.isFetchingNextPage && <Spinner />}Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The latest changes to one item, for its Details dialog. */
export function ItemActivity({ itemId }: { itemId: string }) {
  const { run } = useFolderAccess();
  const activity = useQuery({
    queryKey: ["drive-activity-item", itemId],
    queryFn: ({ signal }) => run(() => listActivity({ itemId, limit: 10 }, signal)),
    staleTime: 15_000,
  });
  const [now] = useState(() => Date.now());
  return (
    <section
      aria-labelledby="item-activity-heading"
      className="flex flex-col gap-2"
    >
      <h3 id="item-activity-heading" className="text-sm font-medium">
        Activity
      </h3>
      {activity.isPending ? (
        <div aria-label="Loading activity" className="flex flex-col gap-2">
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ) : activity.error ? (
        <p role="alert" className="text-xs text-destructive">
          {activity.error.message}
        </p>
      ) : !activity.data.events.length ? (
        <p className="text-xs text-muted-foreground">
          No recorded changes yet.
        </p>
      ) : (
        <ol className="flex max-h-48 flex-col gap-2 overflow-y-auto">
          {activity.data.events.map((event) => (
            <li key={event.id} className="flex items-start gap-2 text-xs">
              <ActorAvatar
                actor={event.actor}
                className="size-5 text-[10px]"
              />
              <p className="min-w-0 flex-1 break-words leading-5 text-muted-foreground">
                <ActivitySentence event={event} />
              </p>
              <span className="leading-5">
                <ActivityTime at={event.at} now={now} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
