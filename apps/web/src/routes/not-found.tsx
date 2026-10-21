import { Link } from '@tanstack/react-router';
import { Empty } from '../components/ui';

export function NotFound() {
  return (
    <div className="page">
      <Empty title="This page does not exist." action={<Link to="/" className="btn btn-secondary btn-md">Go to projects</Link>}>
        The address may be from an older version of Perpeto, or the item was removed.
      </Empty>
    </div>
  );
}
