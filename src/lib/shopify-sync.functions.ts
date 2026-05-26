import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SHOPIFY_API_VERSION = "2025-07";

function shopifyAdmin() {
  const domain = process.env.SHOPIFY_STORE_PERMANENT_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!domain) throw new Error("Missing SHOPIFY_STORE_PERMANENT_DOMAIN");
  if (!token) throw new Error("Missing SHOPIFY_ACCESS_TOKEN");
  return { domain, token };
}

async function shopifyGql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { domain, token } = shopifyAdmin();
  const res = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify GQL ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(`Shopify GQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

export interface VariantRow {
  variantId: string;
  variantSku: string;
  variantTitle: string;
  productId: string;
  productTitle: string;
  imageUrl: string | null;
}

export const listVariants = createServerFn({ method: "GET" }).handler(async (): Promise<VariantRow[]> => {
  const rows: VariantRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: any = await shopifyGql(
      `query($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id title
            variants(first: 100) { edges { node {
              id sku title
              image { url }
            } } }
          } }
        }
      }`,
      { cursor }
    );
    for (const pe of data.products.edges) {
      const p = pe.node;
      for (const ve of p.variants.edges) {
        const v = ve.node;
        if (!v.sku) continue;
        rows.push({
          variantId: v.id,
          variantSku: v.sku,
          variantTitle: v.title,
          productId: p.id,
          productTitle: p.title,
          imageUrl: v.image?.url ?? null,
        });
      }
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return rows;
});

export interface DriveImage {
  id: string;
  name: string;
}

async function driveFetch(path: string): Promise<Response> {
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!apiKey || !lovableKey) throw new Error("Missing Drive credentials");
  return fetch(`https://connector-gateway.lovable.dev/google_drive${path}`, {
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": apiKey,
    },
  });
}

export const listDriveImages = createServerFn({ method: "POST" })
  .inputValidator((d: { folderId: string }) => z.object({ folderId: z.string().min(1) }).parse(d))
  .handler(async ({ data }): Promise<DriveImage[]> => {
    const images: DriveImage[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 20; i++) {
      const q = encodeURIComponent(`'${data.folderId}' in parents and mimeType contains 'image/' and trashed=false`);
      const url = `/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const res = await driveFetch(url);
      if (!res.ok) throw new Error(`Drive list ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { files?: DriveImage[]; nextPageToken?: string };
      images.push(...(json.files ?? []));
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
    return images;
  });

/** Download Drive file, stage upload to Shopify, attach to product, detach existing variant media, append to variant. */
export const syncImageToVariant = createServerFn({ method: "POST" })
  .inputValidator((d: { fileId: string; fileName: string; productId: string; variantId: string }) =>
    z
      .object({
        fileId: z.string().min(1),
        fileName: z.string().min(1),
        productId: z.string().min(1),
        variantId: z.string().min(1),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    // 1) Download from Drive
    const dlRes = await driveFetch(`/drive/v3/files/${data.fileId}?alt=media`);
    if (!dlRes.ok) throw new Error(`Drive download ${dlRes.status}`);
    const buf = new Uint8Array(await dlRes.arrayBuffer());
    const mime = dlRes.headers.get("content-type") ?? "image/jpeg";

    // 2) Staged upload create
    const staged: any = await shopifyGql(
      `mutation($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`,
      {
        input: [
          {
            filename: data.fileName,
            mimeType: mime,
            httpMethod: "POST",
            resource: "IMAGE",
            fileSize: String(buf.byteLength),
          },
        ],
      }
    );
    const errs1 = staged.stagedUploadsCreate.userErrors;
    if (errs1.length) throw new Error(`stagedUploadsCreate: ${JSON.stringify(errs1)}`);
    const target = staged.stagedUploadsCreate.stagedTargets[0];

    // 3) POST file to staged URL (multipart)
    const fd = new FormData();
    for (const p of target.parameters) fd.append(p.name, p.value);
    fd.append("file", new Blob([buf], { type: mime }), data.fileName);
    const upRes = await fetch(target.url, { method: "POST", body: fd });
    if (!upRes.ok && upRes.status !== 201 && upRes.status !== 204) {
      throw new Error(`Staged upload ${upRes.status}: ${(await upRes.text()).slice(0, 300)}`);
    }

    // 4) Attach to product as media
    const created: any = await shopifyGql(
      `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id status } }
          mediaUserErrors { field message }
        }
      }`,
      {
        productId: data.productId,
        media: [{ originalSource: target.resourceUrl, mediaContentType: "IMAGE", alt: data.fileName }],
      }
    );
    const errs2 = created.productCreateMedia.mediaUserErrors;
    if (errs2.length) throw new Error(`productCreateMedia: ${JSON.stringify(errs2)}`);
    const mediaId: string = created.productCreateMedia.media[0].id;

    // 5) Poll until media is READY (max ~30s)
    for (let i = 0; i < 30; i++) {
      const status: any = await shopifyGql(
        `query($id: ID!) { node(id: $id) { ... on MediaImage { id status } } }`,
        { id: mediaId }
      );
      if (status.node?.status === "READY") break;
      if (status.node?.status === "FAILED") throw new Error("Media processing failed");
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 6) Detach existing variant media
    const variantNode: any = await shopifyGql(
      `query($id: ID!) { productVariant(id: $id) { id media(first: 50) { edges { node { id } } } } }`,
      { id: data.variantId }
    );
    const existing: string[] = (variantNode.productVariant?.media?.edges ?? []).map((e: any) => e.node.id);
    if (existing.length) {
      await shopifyGql(
        `mutation($productId: ID!, $variantMedia: [ProductVariantDetachMediaInput!]!) {
          productVariantDetachMedia(productId: $productId, variantMedia: $variantMedia) {
            userErrors { field message }
          }
        }`,
        {
          productId: data.productId,
          variantMedia: [{ variantId: data.variantId, mediaIds: existing }],
        }
      );
    }

    // 7) Append the new media to the variant
    const append: any = await shopifyGql(
      `mutation($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
        productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
          userErrors { field message }
        }
      }`,
      {
        productId: data.productId,
        variantMedia: [{ variantId: data.variantId, mediaIds: [mediaId] }],
      }
    );
    const errs3 = append.productVariantAppendMedia.userErrors;
    if (errs3.length) throw new Error(`productVariantAppendMedia: ${JSON.stringify(errs3)}`);

    return { ok: true, mediaId };
  });
