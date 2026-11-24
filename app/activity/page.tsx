// Activity page (M3-22, DESIGN.md §5.6): the honest audit view, backed
// by action_logs through the listActivity Server Action. A failed load
// passes null, which the timeline renders as "Unavailable".
import { ActivityTimeline } from "@/components/activity-timeline";
import { listActivity } from "./actions";

export const metadata = { title: "Activity · FLASH" };

export default async function Page() {
  const result = await listActivity();
  return <ActivityTimeline rows={result.ok ? result.data : null} />;
}
