import type { Metadata } from "next";
import { CreateAccountForm } from "./create-account-form";

export const metadata: Metadata = { title: "Create your account" };

// Reached right after a Phantom sign-up. The proxy only lets a signed-in
// wallet account that has no password login yet onto this page.
export default function CreateAccountPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <CreateAccountForm />
    </div>
  );
}
