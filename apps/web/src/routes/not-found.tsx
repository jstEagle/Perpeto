import { Link } from '@tanstack/react-router';
import { btn, Empty } from '../components/ui';
import { IconFlag } from '../components/icons';

export function NotFound() {
  return (
    <div className="page">
      <section className="card">
        <Empty title="This page does not exist" icon={<IconFlag />} action={<Link to="/" className={btn('primary')}>Go home</Link>}>
          The address may be from an older version of Perpeto, or the item was removed.
        </Empty>
      </section>
    </div>
  );
}
