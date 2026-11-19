import SiteHeader from "@/components/site-header";

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <>
      <SiteHeader variant="app" />
      <main id="main" className="flex flex-1 flex-col">
        {children}
      </main>
    </>
  );
}
