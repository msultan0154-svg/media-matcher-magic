import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  listProducts,
  listDriveImages,
  syncImagesToProduct,
  driveImageDataUrl,
  type ProductRow,
  type DriveImage,
} from "@/lib/shopify-sync.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Loader2, RefreshCw, ImageOff, Plus, Replace, X, Search, Package, Layers, Image } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  component: SyncApp,
  head: () => ({
    meta: [
      { title: "Shopify Image Sync" },
      { name: "description", content: "Match Drive images to Shopify products by SKU and sync." },
    ],
  }),
});

type Mode = "add" | "replace";

interface MatchRow {
  product: ProductRow;
  files: DriveImage[];
}

/** SKU = portion of filename before the first space. */
function fileSku(name: string): string {
  const sp = name.indexOf(" ");
  return (sp > 0 ? name.slice(0, sp) : name.replace(/\.[^.]+$/, "")).trim();
}

function matchRows(products: ProductRow[], files: DriveImage[]): MatchRow[] {
  const byProduct = new Map<string, DriveImage[]>();
  for (const p of products) byProduct.set(p.productId, []);
  const lowerSkus = products.map((p) => ({
    id: p.productId,
    skus: p.skus.map((s) => s.toLowerCase()),
  }));
  for (const f of files) {
    const sku = fileSku(f.name).toLowerCase();
    if (!sku) continue;
    for (const p of lowerSkus) {
      if (p.skus.includes(sku)) {
        byProduct.get(p.id)!.push(f);
      }
    }
  }
  return products.map((p) => ({
    product: p,
    files: (byProduct.get(p.productId) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

function DriveThumb({ fileId, name, onRemove }: { fileId: string; name: string; onRemove: () => void }) {
  const fetchThumb = useServerFn(driveImageDataUrl);
  const q = useQuery({
    queryKey: ["thumb", fileId],
    queryFn: () => fetchThumb({ data: { fileId } }),
    staleTime: 5 * 60 * 1000,
  });
  return (
    <div className="relative group">
      <div className="h-16 w-16 rounded border bg-muted overflow-hidden flex items-center justify-center">
        {q.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : q.data ? (
          <img src={q.data} alt={name} className="h-full w-full object-cover" />
        ) : (
          <ImageOff className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow opacity-90 hover:opacity-100"
        title={`Remove ${name}`}
      >
        <X className="h-3 w-3" />
      </button>
      <div className="text-[10px] text-muted-foreground mt-1 max-w-[64px] truncate" title={name}>
        {name}
      </div>
    </div>
  );
}

const DEMO_LIMIT = 5;
const DEMO_KEY = "demo_synced_count";

function SyncApp() {
  const [folderId, setFolderId] = useState("");
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<Mode>("add");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Record<string, Set<string>>>({}); // productId -> set of fileIds removed
  const [demoUsed, setDemoUsed] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    return Number(localStorage.getItem(DEMO_KEY) ?? 0);
  });
  const demoRemaining = Math.max(0, DEMO_LIMIT - demoUsed);

  const fetchProducts = useServerFn(listProducts);
  const fetchDrive = useServerFn(listDriveImages);
  const syncOne = useServerFn(syncImagesToProduct);

  const productsQ = useQuery({ queryKey: ["products"], queryFn: () => fetchProducts() });
  const driveQ = useQuery({
    queryKey: ["drive", folderId],
    queryFn: () => fetchDrive({ data: { folderId } }),
    enabled: false,
  });

  const rows = useMemo(() => {
    if (!productsQ.data) return [];
    const all = matchRows(productsQ.data, driveQ.data ?? []);
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.product.productTitle.toLowerCase().includes(q) ||
        r.product.skus.some((s) => s.toLowerCase().includes(q))
    );
  }, [productsQ.data, driveQ.data, search]);

  const effectiveFiles = (r: MatchRow): DriveImage[] => {
    const rem = removed[r.product.productId];
    return rem ? r.files.filter((f) => !rem.has(f.id)) : r.files;
  };

  const eligible = (r: MatchRow) => effectiveFiles(r).length > 0;

  const removeFile = (productId: string, fileId: string) => {
    setRemoved((prev) => {
      const next = { ...prev };
      const s = new Set(next[productId] ?? []);
      s.add(fileId);
      next[productId] = s;
      return next;
    });
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = () => {
    setSelected(new Set(rows.filter(eligible).map((r) => r.product.productId)));
  };

  const syncMu = useMutation({
    mutationFn: async (chosen: MatchRow[]) => {
      let ok = 0;
      let fail = 0;
      let used = demoUsed;
      let blocked = 0;
      for (const r of chosen) {
        const files = effectiveFiles(r);
        if (!files.length) continue;
        if (used >= DEMO_LIMIT) {
          blocked++;
          continue;
        }
        try {
          await syncOne({
            data: {
              productId: r.product.productId,
              mode,
              files: files.map((f) => ({ fileId: f.id, fileName: f.name })),
            },
          });
          ok++;
          used++;
          localStorage.setItem(DEMO_KEY, String(used));
          setDemoUsed(used);
        } catch (e) {
          console.error(e);
          fail++;
        }
      }
      return { ok, fail, blocked };
    },
    onSuccess: ({ ok, fail, blocked }) => {
      toast.success(
        `Synced ${ok} product${ok === 1 ? "" : "s"}${fail ? `, ${fail} failed` : ""}${blocked ? `, ${blocked} skipped (demo limit)` : ""}`
      );
      setSelected(new Set());
      productsQ.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const confirm = () => {
    const chosen = rows.filter((r) => selected.has(r.product.productId) && eligible(r));
    if (!chosen.length) {
      toast.error("Nothing selected");
      return;
    }
    if (demoRemaining === 0) {
      toast.error("Demo limit reached. Upgrade to sync more products.");
      return;
    }
    if (chosen.length > demoRemaining) {
      toast.warning(`Demo allows ${demoRemaining} more sync${demoRemaining === 1 ? "" : "s"}. Extra products will be skipped.`);
    }
    syncMu.mutate(chosen);
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster position="top-right" />
      <div className="mx-auto max-w-6xl p-6 space-y-6">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Filename SKU = text before the first space. All matching images are listed per product.
            </p>
          </div>
          <div className={`rounded-lg border px-4 py-2 text-sm ${demoRemaining === 0 ? "border-destructive bg-destructive/10 text-destructive" : "bg-muted"}`}>
            <div className="font-medium">Demo version</div>
            <div className="text-xs">
              {demoRemaining > 0
                ? `${demoRemaining} of ${DEMO_LIMIT} product syncs remaining`
                : "Limit reached — upgrade to continue"}
            </div>
          </div>
        </header>

        {productsQ.data && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="p-4 flex items-center gap-4">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Package className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="text-2xl font-bold">{productsQ.data.length}</div>
                <div className="text-xs text-muted-foreground">Total Products</div>
              </div>
            </Card>
            <Card className="p-4 flex items-center gap-4">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Layers className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {productsQ.data.reduce((sum, p) => sum + p.skus.length, 0)}
                </div>
                <div className="text-xs text-muted-foreground">Total Variants</div>
              </div>
            </Card>
            <Card className="p-4 flex items-center gap-4">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Image className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {productsQ.data.reduce((sum, p) => sum + p.imageCount, 0)}
                </div>
                <div className="text-xs text-muted-foreground">Total Images</div>
              </div>
            </Card>
            <Card className="p-4 flex items-center gap-4">
              <div className="h-10 w-10 rounded-full bg-destructive/10 flex items-center justify-center">
                <ImageOff className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {productsQ.data.filter((p) => p.imageCount === 0).length}
                </div>
                <div className="text-xs text-muted-foreground">Products without images</div>
              </div>
            </Card>
          </div>
        )}

        <Card className="p-4 space-y-3">
          <Label htmlFor="folder">Google Drive folder ID</Label>
          <div className="flex gap-2">
            <Input
              id="folder"
              placeholder="e.g. 1aBcD..."
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
            />
            <Button onClick={() => driveQ.refetch()} disabled={!folderId || driveQ.isFetching}>
              {driveQ.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Scan</span>
            </Button>
            <Button variant="outline" onClick={() => productsQ.refetch()} disabled={productsQ.isFetching}>
              Reload products
            </Button>
          </div>
          {driveQ.data && (
            <p className="text-xs text-muted-foreground">
              {driveQ.data.length} images · {productsQ.data?.length ?? 0} products
            </p>
          )}
        </Card>

        <Card className="p-4 space-y-3">
          <Label htmlFor="search">Search products</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="search"
              placeholder="Type product title or SKU..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {search && (
            <p className="text-xs text-muted-foreground">
              Showing {rows.length} of {productsQ.data?.length ?? 0} products
            </p>
          )}
        </Card>

        <Card className="p-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium mr-1">Mode:</span>
          <Button
            size="sm"
            variant={mode === "add" ? "default" : "outline"}
            onClick={() => setMode("add")}
          >
            <Plus className="h-4 w-4 mr-1" /> Add images only
          </Button>
          <Button
            size="sm"
            variant={mode === "replace" ? "default" : "outline"}
            onClick={() => setMode("replace")}
          >
            <Replace className="h-4 w-4 mr-1" /> Replace images
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={selectAll} disabled={!rows.some(eligible)}>
            Select all matched
          </Button>
          <Button size="sm" onClick={confirm} disabled={syncMu.isPending || !selected.size}>
            {syncMu.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            {mode === "add" ? "Add" : "Replace"} ({selected.size})
          </Button>
        </Card>

        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 w-8"></th>
                  <th className="p-2 w-16">Now</th>
                  <th className="p-2">Product</th>
                  <th className="p-2">Matched images</th>
                </tr>
              </thead>
              <tbody>
                {productsQ.isLoading ? (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin inline" /> Loading products…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-muted-foreground">
                      No products
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => {
                    const id = r.product.productId;
                    const files = effectiveFiles(r);
                    const disabled = !eligible(r);
                    return (
                      <tr key={id} className="border-t align-top">
                        <td className="p-2 pt-4">
                          <Checkbox
                            checked={selected.has(id)}
                            onCheckedChange={() => toggle(id)}
                            disabled={disabled}
                          />
                        </td>
                        <td className="p-2 pt-3">
                          {r.product.firstImageUrl ? (
                            <img
                              src={r.product.firstImageUrl}
                              alt=""
                              className="h-10 w-10 object-cover rounded"
                            />
                          ) : (
                            <div className="h-10 w-10 rounded bg-muted flex items-center justify-center">
                              <ImageOff className="h-4 w-4 text-muted-foreground" />
                            </div>
                          )}
                        </td>
                        <td className="p-2 pt-3">
                          <div className="font-medium truncate max-w-xs">{r.product.productTitle}</div>
                          <div className="text-xs text-muted-foreground font-mono truncate max-w-xs">
                            {r.product.skus.join(", ")}
                          </div>
                        </td>
                        <td className="p-2 pt-3">
                          {files.length === 0 ? (
                            <Badge variant="outline">No match</Badge>
                          ) : (
                            <div className="flex flex-wrap gap-3">
                              {files.map((f) => (
                                <DriveThumb
                                  key={f.id}
                                  fileId={f.id}
                                  name={f.name}
                                  onRemove={() => removeFile(id, f.id)}
                                />
                              ))}
                            </div>
                          )}
                        </td>
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
