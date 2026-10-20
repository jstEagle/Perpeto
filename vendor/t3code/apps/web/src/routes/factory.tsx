import { createFileRoute, redirect } from "@tanstack/react-router";
import { FactoryMessagingPage } from "../components/factory/FactoryMessagingPage";

export const Route = createFileRoute("/factory")({
  beforeLoad: ({ context }) => {
    if (context.authGateState.status !== "authenticated" && context.authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: FactoryMessagingPage,
});
