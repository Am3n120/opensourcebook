import { Navigate, Route, Routes } from "react-router";
import { Shell } from "./app/Shell";
import { FirstRun } from "./firstrun/FirstRun";
import { FirstRunGate } from "./firstrun/gate";
import { FeedScreen } from "./feed/FeedScreen";
import { isPhone } from "./feed/phone";
import { PlayerScreen } from "./player/PlayerScreen";
import { ProjectScreen } from "./project/ProjectScreen";
import { PlanLink, SourcePage } from "./project/redirects";
import { Home } from "./screens/Home";
import { Inbox } from "./screens/Inbox";
import { Library } from "./screens/Library";
import { NotFound } from "./screens/NotFound";
import { Activity } from "./screens/Activity";
import { Settings } from "./screens/Settings";

/** The Library tab: everything made as a grid on a computer, and as the feed on a phone. */
function LibraryTab() {
  return isPhone() ? <FeedScreen /> : <Library />;
}

export function App() {
  return (
    <Routes>
      {/* A project, a player and the phone's feed fill the window, without the shell. */}
      <Route path="projects/:id" element={<ProjectScreen />} />
      <Route path="outputs/:id" element={<PlayerScreen />} />
      <Route path="welcome/:step?" element={<FirstRun />} />
      <Route path="feed" element={<FeedScreen />} />
      <Route path="projects" element={<Navigate replace to="/" />} />
      <Route element={<Shell />}>
        <Route index element={<FirstRunGate><Home /></FirstRunGate>} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="sources/:id" element={<SourcePage />} />
        <Route path="plans/:id" element={<PlanLink />} />
        <Route path="library" element={<LibraryTab />} />
        <Route path="settings" element={<Settings />} />
        <Route path="settings/activity" element={<Activity />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
