"use client";

import { CloudOff } from "lucide-react";
import { Dashboard } from "@/components/dashboard";
import { Landing } from "@/components/landing";
import { Pending, Register } from "@/components/onboarding";
import { useSession } from "@/components/session-provider";
import { Notice, Shell, Splash } from "@/components/shell";
import { Button } from "@/components/ui";

/** Signed out, the landing page; signed in, the step the account is at. */
export default function Home() {
  const { hydrated, signedIn, me, meError, refreshMe } = useSession();

  if (!hydrated) return <Splash />;
  if (signedIn === false) return <Landing />;
  if (meError) {
    return (
      <Shell>
        <Notice
          icon={<CloudOff className="size-6" />}
          title="Couldn't reach the portal"
          action={<Button onClick={() => void refreshMe()}>Try again</Button>}
        >
          {meError}
        </Notice>
      </Shell>
    );
  }
  if (!me) return <Splash />;
  return (
    <Shell>
      {me.status === "none" && <Register />}
      {me.status === "pending" && <Pending me={me} />}
      {me.status === "approved" && me.org && <Dashboard org={me.org} />}
    </Shell>
  );
}
