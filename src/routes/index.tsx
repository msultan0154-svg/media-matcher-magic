import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  listVariants,
  listDriveImages,
  syncImageToVariant,
  type VariantRow,
  type DriveImage,
} from "@/lib/shopify-sync.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Loader2, RefreshCw, ImageIcon, ImageOff, Images } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  component: SyncApp,
  head: () => ({
    meta: [
      { title: "Shopify Image Sync" },
      { name: "description", content: "Match Drive images to Shopify variants by SKU and sync." },
    ],
  }),
});

type Filter = "all" | "no-image" | "has-image";

interface MatchRow {
  variant: VariantRow;
  file: DriveImage | null;
  skuKey: string | null;
  position: number;
}

/** Parse `<base>_<pos>.<ext>` — last "_" separates SKU portion from numeric position. */
function parseFilename(name: string): { base: string; position: number } {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const us = stem.lastIndexOf("_");
  if (us > 0) {
    const tail = stem.slice(us + 1);
    if (/^\d+$/.test(tail)) return { base: stem.slice(0, us), position: parseInt(tail, 10) };
  }
  return { base: stem, position: 0 };
}

function matchRows(variants: VariantRow[], files: DriveImage[]): MatchRow[] {
  // For each variant, find the lowest-position file whose filename CONTAINS the SKU.
  const parsed = files.map((f) => ({ file: f, ...parseFilename(f.name) }));
  return variants.map((v) => {
    const sku = v.variantSku;
    const candidates = parsed
      .filter((p) => sku && p.file.name.toLowerCase().includes(sku.toLowerCase()))
      .sort((a, b) => a.position - b.position);
    const best = candidates[0];
    return {
      variant: v,
      file: best?.file ?? null,
      skuKey: best ? best.base : null,
      position: best?.position ?? 0,
    };
  });
}

function SyncApp() {
  const [folderId, setFolderId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchVariants = useServerFn(listVariants);
  const fetchDrive = useServerFn(listDriveImages);
  const syncOne = useServerFn(syncImageToVariant);

  const variantsQ = useQuery({
    queryKey: ["variants"],
    queryFn: () => fetchVariants(),
  });

  const driveQ = useQuery({
    queryKey: ["drive", folderId],
    queryFn: () => fetchDrive({ data: { folderId } }),
    enabled: false,
  });

  const rows = useMemo(() => {
    if (!variantsQ.data) return [];
    return matchRows(variantsQ.data, driveQ.data ?? []);
  }, [variantsQ.data, driveQ.data]);

  const visibleRows = useMemo(() => {
    return rows.filter((r) => {
      if (filter === "no-image") return !r.variant.imageUrl;
      if (filter === "has-image") return !!r.variant.imageUrl;
      return true;
    });
  }, [rows, filter]);

  const syncMu = useMutation({
    mutationFn: async (matched: MatchRow[]) => {
      let ok = 0;
      let fail = 0;
      for (const r of matched) {
        if (!r.file) continue;
        try {
          await syncOne({
            data: {
              fileId: r.file.id,
              fileName: r.file.name,
              productId: r.variant.productId,
              variantId: r.variant.variantId,
            },
          });
          ok++;
        } catch (e) {
          console.error(e);
          fail++;
        }
      }
      return { ok, fail };
    },
    onSuccess: ({ ok, fail }) => {
      toast.success(`Synced ${ok}${fail ? `, ${fail} failed` : ""}`);
      setSelected(new Set());
      variantsQ.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAllVisible = () => {
    const ids = visibleRows.filter((r) => r.file).map((r) => r.variant.variantId);
    setSelected(new Set(ids));
  };

  const confirm = () => {
    const chosen = visibleRows.filter((r) => selected.has(r.variant.variantId) && r.file);
    if (!chosen.length) {
      toast.error("Nothing selected");
      return;
    }
    syncMu.mutate(chosen);
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster position="top-right" />
      <div className="mx-auto max-w-6xl p-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Shopify Image Sync</h1>
          <p className="text-sm text-muted-foreground">
            Match Drive images to variants by SKU substring. Filename format: <code>...SKU..._N.ext</code> — last
            <code>_N</code> sets order.
          </p>
        </header>

        <Card className="p-4 space-y-3">
          <Label htmlFor="folder">Google Drive folder ID</Label>
          <div className="flex gap-2">
            <Input
              id="folder"
              placeholder="e.g. 1aBcD..."
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
            />
            <Button
              onClick={() => driveQ.refetch()}
              disabled={!folderId || driveQ.isFetching}
            >
              {driveQ.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Scan</span>
            </Button>
            <Button variant="outline" onClick={() => variantsQ.refetch()} disabled={variantsQ.isFetching}>
              Reload variants
            </Button>
          </div>
          {driveQ.data && (
            <p className="text-xs text-muted-foreground">
              {driveQ.data.length} images in folder · {variantsQ.data?.length ?? 0} variants
            </p>
          )}
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={filter === "all" ? "default" : "outline"} onClick={() => setFilter("all")}>
            <Images className="h-4 w-4 mr-1" /> All
          </Button>
          <Button
            size="sm"
            variant={filter === "no-image" ? "default" : "outline"}
            onClick={() => setFilter("no-image")}
          >
            <ImageOff className="h-4 w-4 mr-1" /> No image
          </Button>
          <Button
            size="sm"
            variant={filter === "has-image" ? "default" : "outline"}
            onClick={() => setFilter("has-image")}
          >
            <ImageIcon className="h-4 w-4 mr-1" /> Has image
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={selectAllVisible} disabled={!visibleRows.length}>
            Select all visible
          </Button>
          <Button size="sm" onClick={confirm} disabled={syncMu.isPending || !selected.size}>
            {syncMu.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Confirm &amp; Sync ({selected.size})
          </Button>
        </div>

        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 w-8"></th>
                  <th className="p-2 w-16">Now</th>
                  <th className="p-2">Variant SKU</th>
                  <th className="p-2">Product</th>
                  <th className="p-2">Matched file</th>
                  <th className="p-2 w-16">Pos</th>
                </tr>
              </thead>
              <tbody>
                {variantsQ.isLoading ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin inline" /> Loading variants…
                    </td>
                  </tr>
                ) : visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">
                      No rows
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((r) => {
                    const id = r.variant.variantId;
                    const disabled = !r.file;
                    return (
                      <tr key={id} className="border-t">
                        <td className="p-2">
                          <Checkbox
                            checked={selected.has(id)}
                            onCheckedChange={() => toggle(id)}
                            disabled={disabled}
                          />
                        </td>
                        <td className="p-2">
                          {r.variant.imageUrl ? (
                            <img
                              src={r.variant.imageUrl}
                              alt=""
                              className="h-10 w-10 object-cover rounded"
                            />
                          ) : (
                            <div className="h-10 w-10 rounded bg-muted flex items-center justify-center">
                              <ImageOff className="h-4 w-4 text-muted-foreground" />
                            </div>
                          )}
                        </td>
                        <td className="p-2 font-mono text-xs">{r.variant.variantSku}</td>
                        <td className="p-2">
                          <div className="truncate max-w-xs">{r.variant.productTitle}</div>
                          <div className="text-xs text-muted-foreground">{r.variant.variantTitle}</div>
                        </td>
                        <td className="p-2">
                          {r.file ? (
                            <span className="font-mono text-xs">{r.file.name}</span>
                          ) : (
                            <Badge variant="outline">No match</Badge>
                          )}
                        </td>
                        <td className="p-2">{r.file ? r.position : ""}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
