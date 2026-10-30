import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Film, ImageIcon, Loader2, Megaphone, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  AD_IMAGE_TYPES, AD_VIDEO_TYPES, bannerStatus, deleteAdBanner, loadAdBanners, normaliseBannerLink, saveAdBanner,
  sortBanners, uploadAdMedia, type AdBanner,
} from "@/lib/ad-banners";
import { cn } from "@/lib/utils";
import { festiveStatus, saveFestiveSetting, useFestiveTheme } from "@/lib/festive";

export const Route = createFileRoute("/admin/ads")({
  head: () => ({
    meta: [
      { title: "Ad Banners | Shami Business Ventures Admin" },
      { name: "description", content: "Offer, deal and festival banners and promo videos on the storefront home page." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminAds,
});

type Draft = Omit<AdBanner, "id"> & { id?: string };

const emptyDraft = (sortOrder: number): Draft => ({
  title: "", subtitle: "", mediaKind: "image", mediaUrl: "", mobileMediaUrl: null, fit: "cover",
  background: "#1f3d2f", linkUrl: "", ctaLabel: "", placement: "main", sortOrder, active: true, startsAt: null, endsAt: null,
});

/** "2026-10-30T10:00" (the browser's local time) <-> ISO, for the schedule inputs. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

function MediaPreview({ banner, className }: { banner: Pick<AdBanner, "mediaKind" | "mediaUrl" | "fit" | "background" | "title">; className?: string }) {
  if (!banner.mediaUrl) {
    return (
      <div className={cn("grid place-items-center rounded-lg border border-dashed border-border bg-ivory text-xs text-slate", className)}>
        No picture or video yet
      </div>
    );
  }
  const fit = banner.fit === "contain" ? "object-contain" : "object-cover";
  return (
    <div className={cn("overflow-hidden rounded-lg", className)} style={{ backgroundColor: banner.background }}>
      {banner.mediaKind === "video"
        ? <video src={banner.mediaUrl} muted loop autoPlay playsInline className={cn("h-full w-full", fit)} />
        : <img src={banner.mediaUrl} alt={banner.title || "Banner"} className={cn("h-full w-full", fit)} />}
    </div>
  );
}

/** On/off switch for the festival decorations on the home page (they also end by themselves after the dates). */
function FestiveThemePanel() {
  const { setting, ready, window: dates } = useFestiveTheme();
  const [saving, setSaving] = useState(false);
  const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  const set = async (enabled: boolean) => {
    setSaving(true);
    try {
      await saveFestiveSetting({ enabled });
      toast.success(enabled ? "Festival decorations are ON" : "Festival decorations are OFF");
    } catch (cause) {
      toast.error("Could not change the festival decorations", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title="Festival decorations (Deepavali)" className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl space-y-1 text-sm text-slate">
          <p>Diyas, marigold toran, rangoli and festive lights on the home page, from {fmt(dates.from)} to {fmt(new Date(Date.parse(dates.until) - 1).toISOString())}. They switch off by themselves after that.</p>
          <p>Turn this off to remove them from the store at once. Festival banners are separate: manage them below.</p>
          <p className="font-semibold text-navy">{ready ? festiveStatus(setting) : "Checking…"}</p>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-navy">
          <Switch checked={setting.enabled} disabled={!ready || saving} onCheckedChange={(on) => void set(on)} aria-label="Festival decorations" />
          {setting.enabled ? "ON" : "OFF"}
        </label>
      </div>
    </Panel>
  );
}

function AdminAds() {
  const [banners, setBanners] = useState<AdBanner[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<"main" | "mobile" | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBanners(sortBanners(await loadAdBanners()));
    } catch (cause) {
      toast.error("Could not load the banners", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const stats = useMemo(() => {
    const now = Date.now();
    const status = banners.map((b) => bannerStatus(b, now));
    return {
      live: status.filter((s) => s === "Live").length,
      scheduled: status.filter((s) => s === "Scheduled").length,
      videos: banners.filter((b) => b.mediaKind === "video").length,
    };
  }, [banners]);

  const upload = async (file: File | undefined, which: "main" | "mobile") => {
    if (!file || !draft) return;
    setUploading(which);
    try {
      const url = await uploadAdMedia(file);
      setDraft((current) => current && (which === "main"
        // a new main file of the other kind drops the old phone version (a picture can't stand in for a video)
        ? { ...current, mediaUrl: url, mediaKind: AD_VIDEO_TYPES.includes(file.type) ? "video" : "image",
            mobileMediaUrl: (AD_VIDEO_TYPES.includes(file.type) ? "video" : "image") === current.mediaKind ? current.mobileMediaUrl : null }
        : { ...current, mobileMediaUrl: url }));
      toast.success(which === "main" ? "Uploaded" : "Phone version uploaded");
    } catch (cause) {
      toast.error("Upload failed", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setUploading(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.mediaUrl) { toast.error("Upload a picture or video first"); return; }
    if (draft.linkUrl && !normaliseBannerLink(draft.linkUrl)) {
      toast.error("Check the link", { description: "Use a page on this site such as /shop?category=Rice, or a full https:// address." });
      return;
    }
    if (draft.startsAt && draft.endsAt && Date.parse(draft.endsAt) <= Date.parse(draft.startsAt)) {
      toast.error("The end must be after the start");
      return;
    }
    setSaving(true);
    try {
      await saveAdBanner(draft.id ? (draft as AdBanner) : { ...draft, id: undefined });
      toast.success(draft.id ? "Banner updated" : "Banner added", { description: draft.active ? "It shows on the home page while it is live." : "It is saved switched off." });
      setDraft(null);
      await refresh();
    } catch (cause) {
      toast.error("Could not save the banner", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSaving(false);
    }
  };

  const move = async (banner: AdBanner, direction: -1 | 1) => {
    const list = sortBanners(banners.filter((b) => b.placement === banner.placement));
    const at = list.findIndex((b) => b.id === banner.id);
    const other = list[at + direction];
    if (!other) return;
    try {
      // Swap the two positions (re-numbered so ties never stick).
      await saveAdBanner({ ...banner, sortOrder: (at + direction) * 10 });
      await saveAdBanner({ ...other, sortOrder: at * 10 });
      await refresh();
    } catch (cause) {
      toast.error("Could not reorder", { description: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const toggle = async (banner: AdBanner, active: boolean) => {
    try {
      await saveAdBanner({ ...banner, active });
      await refresh();
    } catch (cause) {
      toast.error("Could not change the banner", { description: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const remove = async (banner: AdBanner) => {
    try {
      await deleteAdBanner(banner.id);
      toast.success("Banner removed");
      await refresh();
    } catch (cause) {
      toast.error("Could not remove the banner", { description: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const section = (placement: "main" | "side", title: string, hint: string) => {
    const list = sortBanners(banners.filter((b) => b.placement === placement));
    return (
      <Panel
        title={title}
        action={<Button size="sm" onClick={() => setDraft({ ...emptyDraft(list.length * 10), placement })}><Plus className="mr-1 h-4 w-4" /> Add</Button>}
      >
        <p className="mb-4 text-xs text-slate">{hint}</p>
        {list.length === 0 && !loading && (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-slate">No banners here yet.</p>
        )}
        <ul className="space-y-3">
          {list.map((banner, i) => (
            <li key={banner.id} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center">
              <MediaPreview banner={banner} className={cn("w-full shrink-0 sm:w-56", placement === "main" ? "aspect-[21/9]" : "aspect-[16/9]")} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={bannerStatus(banner)} />
                  <span className="inline-flex items-center gap-1 text-[11px] text-slate">
                    {banner.mediaKind === "video" ? <Film className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
                    {banner.mediaKind === "video" ? "Video" : "Picture"} · {banner.fit === "contain" ? "Whole picture" : "Fill"}
                  </span>
                </div>
                <p className="truncate font-semibold text-navy">{banner.title || "(no title)"}</p>
                {banner.subtitle && <p className="truncate text-xs text-slate">{banner.subtitle}</p>}
                <p className="truncate text-[11px] text-slate">
                  {banner.linkUrl ? `Opens ${banner.linkUrl}` : "No link"}
                  {banner.startsAt ? ` · from ${new Date(banner.startsAt).toLocaleString("en-IN")}` : ""}
                  {banner.endsAt ? ` · until ${new Date(banner.endsAt).toLocaleString("en-IN")}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Switch checked={banner.active} onCheckedChange={(on) => void toggle(banner, on)} aria-label={banner.active ? "Switch off" : "Switch on"} />
                <Button variant="outline" size="icon" disabled={i === 0} onClick={() => void move(banner, -1)} aria-label="Move up"><ArrowUp className="h-4 w-4" /></Button>
                <Button variant="outline" size="icon" disabled={i === list.length - 1} onClick={() => void move(banner, 1)} aria-label="Move down"><ArrowDown className="h-4 w-4" /></Button>
                <Button variant="outline" size="icon" onClick={() => setDraft({ ...banner })} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="Remove"><Trash2 className="h-4 w-4 text-danger" /></Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove this banner?</AlertDialogTitle>
                      <AlertDialogDescription>It disappears from the home page. To hide it for now, switch it off instead.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void remove(banner)}>Remove</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    );
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Ad Banners" subtitle="Offers, deals, new products, festival banners and promo videos on the home page">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Live now" value={String(stats.live)} icon={Megaphone} />
        <StatCard label="Scheduled" value={String(stats.scheduled)} icon={Megaphone} />
        <StatCard label="Videos" value={String(stats.videos)} icon={Film} />
      </div>
      <FestiveThemePanel />
      {loading && <p className="mt-6 inline-flex items-center gap-2 text-sm text-slate"><Loader2 className="h-4 w-4 animate-spin" /> Loading banners…</p>}
      <div className="mt-6 grid gap-6">
        {section("main", "Big sliding banner", "Slides one after another at the top of the home page (videos play to the end). Best size 2100 × 900 (21:9); any size works: choose Fill or Whole picture.")}
        {section("side", "Side tiles", "Beside the big banner on computers, and a moving strip under it on phones. Best size 1280 × 720 (16:9).")}
      </div>

      <Dialog open={!!draft} onOpenChange={(open) => { if (!open && !saving) setDraft(null); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit banner" : "Add banner"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label>Picture or video *</Label>
                <MediaPreview banner={draft} className={draft.placement === "main" ? "aspect-[21/9]" : "aspect-[16/9]"} />
                <label className="inline-flex w-max cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-semibold text-navy hover:border-gold">
                  {uploading === "main" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {draft.mediaUrl ? "Replace" : "Upload"}
                  <input type="file" className="sr-only" accept={[...AD_IMAGE_TYPES, ...AD_VIDEO_TYPES].join(",")}
                    disabled={!!uploading} onChange={(e) => { void upload(e.target.files?.[0], "main"); e.target.value = ""; }} />
                </label>
                <p className="text-[11px] text-slate">JPG, PNG, WebP, GIF, AVIF, or an MP4 / WebM video (plays muted), up to 50 MB.</p>
              </div>

              {draft.mediaUrl && (
                <div className="grid gap-2">
                  <Label>{draft.mediaKind === "video" ? "Phone video (optional)" : "Phone picture (optional)"}</Label>
                  <div className="flex flex-wrap items-center gap-3">
                    {draft.mobileMediaUrl && <MediaPreview banner={{ ...draft, mediaUrl: draft.mobileMediaUrl }} className="aspect-[16/9] w-40" />}
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-semibold text-navy hover:border-gold">
                      {uploading === "mobile" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      {draft.mobileMediaUrl ? "Replace" : "Upload"}
                      <input type="file" className="sr-only" accept={(draft.mediaKind === "video" ? AD_VIDEO_TYPES : AD_IMAGE_TYPES).join(",")}
                        disabled={!!uploading} onChange={(e) => { void upload(e.target.files?.[0], "mobile"); e.target.value = ""; }} />
                    </label>
                    {draft.mobileMediaUrl && <Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, mobileMediaUrl: null })}>Remove</Button>}
                  </div>
                  <p className="text-[11px] text-slate">A separate 16:9 version for phones. Without it phones show the main {draft.mediaKind === "video" ? "video" : "picture"}, cropped at the sides.</p>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Where</Label>
                  <Select value={draft.placement} onValueChange={(v) => setDraft({ ...draft, placement: v as AdBanner["placement"] })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="main">Big sliding banner</SelectItem>
                      <SelectItem value="side">Side tile</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>Size</Label>
                  <Select value={draft.fit} onValueChange={(v) => setDraft({ ...draft, fit: v as AdBanner["fit"] })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cover">Fill the banner (edges may be cropped)</SelectItem>
                      <SelectItem value="contain">Show the whole picture</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="ad-title">Title (optional)</Label>
                  <Input id="ad-title" maxLength={120} value={draft.title} placeholder="e.g. Diwali offer: 5% off on Sona Masoori" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="ad-subtitle">Line under the title (optional)</Label>
                  <Input id="ad-subtitle" maxLength={200} value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ad-link">Opens (optional)</Label>
                  <Input id="ad-link" value={draft.linkUrl ?? ""} placeholder="/shop?category=Rice" onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ad-cta">Button text (optional)</Label>
                  <Input id="ad-cta" maxLength={40} value={draft.ctaLabel} placeholder="Shop now" onChange={(e) => setDraft({ ...draft, ctaLabel: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ad-start">Show from (optional)</Label>
                  <Input id="ad-start" type="datetime-local" value={toLocalInput(draft.startsAt)} onChange={(e) => setDraft({ ...draft, startsAt: fromLocalInput(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ad-end">Show until (optional)</Label>
                  <Input id="ad-end" type="datetime-local" value={toLocalInput(draft.endsAt)} onChange={(e) => setDraft({ ...draft, endsAt: fromLocalInput(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ad-bg">Background colour</Label>
                  <div className="flex items-center gap-2">
                    <input id="ad-bg" type="color" value={draft.background} onChange={(e) => setDraft({ ...draft, background: e.target.value })} className="h-10 w-14 cursor-pointer rounded border border-border bg-white p-1" />
                    <span className="text-xs text-slate">Shows around a picture shown whole.</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 pt-6">
                  <Switch id="ad-active" checked={draft.active} onCheckedChange={(on) => setDraft({ ...draft, active: on })} />
                  <Label htmlFor="ad-active">On (shows while inside its dates)</Label>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={saving || !!uploading} onClick={() => void save()}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
