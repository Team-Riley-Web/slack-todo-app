import { Nav } from './Nav';

/** Chrome shared by every signed-in page. */
export function Shell(props: {
  current: string;
  who: string | null;
  children: React.ReactNode;
}) {
  return (
    <>
      <Nav current={props.current} who={props.who} />
      <main className="shell">{props.children}</main>
    </>
  );
}
