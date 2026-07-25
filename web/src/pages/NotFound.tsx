import { Card, EmptyState, LinkButton } from "../components/ui.js";

export function NotFound() {
  return (
    <Card>
      <EmptyState
        icon="info"
        title="Page not found"
        message="That route doesn't exist in TorHQ."
        actions={<LinkButton to="/" variant="primary" icon="dashboard">Back to dashboard</LinkButton>}
      />
    </Card>
  );
}
