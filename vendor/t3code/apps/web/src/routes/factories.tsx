import { createFileRoute, redirect } from "@tanstack/react-router";
import { FactoryEditorPage } from "../components/factory/FactoryEditorPage";
export const Route = createFileRoute("/factories")({
  beforeLoad: ({ context }) => {
    if (context.authGateState.status !== "authenticated" && context.authGateState.status !== "hosted-static") throw redirect({ to: "/pair", replace: true });
  },
  component: FactoryEditorPage,
});
