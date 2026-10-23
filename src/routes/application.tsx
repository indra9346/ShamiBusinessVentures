import { createFileRoute, redirect } from "@tanstack/react-router";

// grainbazar.com/application was shared as the live link; the shop lives at the site root.
export const Route = createFileRoute("/application")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
