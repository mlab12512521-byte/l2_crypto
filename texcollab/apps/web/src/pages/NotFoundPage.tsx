import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="narrow stack">
      <h1>Page not found</h1>
      <p className="muted">The page does not exist or you do not have access to it.</p>
      <Link to="/">Back to projects</Link>
    </div>
  );
}
