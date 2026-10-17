import { useEffect, useState } from "react";
import { Contact } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type ContactsManager = { select: (props: string[], options: { multiple: boolean }) => Promise<{ name?: string[]; tel?: string[] }[]> };

/**
 * "Pick from contacts" (Android Chrome): the customer chooses one contact from their own phone
 * book and its name and phone number fill the form. Nothing is read without that choice, and the
 * button is hidden where the browser does not support it.
 */
export function PickContactButton({ onPicked, className }: { onPicked: (contact: { name: string; phone: string }) => void; className?: string }) {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && "contacts" in navigator && typeof window !== "undefined" && "ContactsManager" in window);
  }, []);
  if (!supported) return null;
  const pick = async () => {
    try {
      const contacts = (navigator as unknown as { contacts: ContactsManager }).contacts;
      const [chosen] = await contacts.select(["name", "tel"], { multiple: false });
      if (!chosen) return;
      const name = (chosen.name?.[0] ?? "").trim();
      // Keep the 10-digit Indian mobile number (drop +91 / spaces / dashes).
      const phone = (chosen.tel?.[0] ?? "").replace(/\D/g, "").slice(-10);
      onPicked({ name, phone });
      toast.success("Filled from your contact", { description: [name, phone].filter(Boolean).join(" · ") });
    } catch {
      /* the customer closed the picker */
    }
  };
  return (
    <Button type="button" variant="outline" size="sm" className={className} onClick={() => void pick()}>
      <Contact className="mr-1.5 h-4 w-4 text-gold" /> Pick from contacts
    </Button>
  );
}
