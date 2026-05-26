import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SHOPIFY_API_VERSION = "2025-07";
const SHOPIFY_DOMAIN = "smart-image-capture.myshopify.com";

function shopifyAdmin() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error("Missing SHOPIFY_ACCESS_TOKEN");
  return { domain: SHOPIFY_DOMAIN, token };
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

export interface ProductRow {
  productId: string;
  productTitle: string;
  skus: string[];
  imageCount: number;
  firstImageUrl: string | null;
}

export const listProducts = createServerFn({ method: "GET" }).handler(async (): Promise<ProductRow[]> => {
  const rows: ProductRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: any = await shopifyGql(
      `query($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id title
            images(first: 1) { edges { node { url } } }
            media(first: 1) { edges { node { id } } }
            variants(first: 100) { edges { node { sku } } }
          } }
        }
      }`,
      { cursor }
    );
    for (const pe of data.products.edges) {
      const p = pe.node;
      const skus: string[] = p.variants.edges
        .map((e: any) => e.node.sku)
        .filter((s: string | null) => !!s);
      rows.push({
        productId: p.id,
        productTitle: p.title,
        skus,
        imageCount: p.media.edges.length,
        firstImageUrl: p.images.edges[0]?.node.url ?? null,
      });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return rows;
});

export interface DriveImage {
  id: string;
  name: string;
  thumbnailLink?: string;
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
      const url = `/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,thumbnailLink)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const res = await driveFetch(url);
      if (!res.ok) throw new Error(`Drive list ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { files?: DriveImage[]; nextPageToken?: string };
      images.push(...(json.files ?? []));
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
    return images;
  });

/** Return a base64 data URL for a Drive thumbnail (proxied since thumbnailLink requires auth). */
export const driveImageDataUrl = createServerFn({ method: "POST" })
  .inputValidator((d: { fileId: string }) => z.object({ fileId: z.string().min(1) }).parse(d))
  .handler(async ({ data }): Promise<string> => {
    const res = await driveFetch(`/drive/v3/files/${data.fileId}?alt=media`);
    if (!res.ok) throw new Error(`Drive thumb ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get("content-type") ?? "image/jpeg";
    // Convert without exceeding stack
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const b64 = btoa(bin);
    return `data:${mime};base64,${b64}`;
  });

async function uploadOneToProduct(
  productId: string,
  file: { fileId: string; fileName: string }
): Promise<string> {
  const dlRes = await driveFetch(`/drive/v3/files/${file.fileId}?alt=media`);
  if (!dlRes.ok) throw new Error(`Drive download ${dlRes.status}`);
  const buf = new Uint8Array(await dlRes.arrayBuffer());
  const mime = dlRes.headers.get("content-type") ?? "image/jpeg";

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
          filename: file.fileName,
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

  const fd = new FormData();
  for (const p of target.parameters) fd.append(p.name, p.value);
  fd.append("file", new Blob([buf], { type: mime }), file.fileName);
  const upRes = await fetch(target.url, { method: "POST", body: fd });
  if (!upRes.ok && upRes.status !== 201 && upRes.status !== 204) {
    throw new Error(`Staged upload ${upRes.status}: ${(await upRes.text()).slice(0, 300)}`);
  }

  const created: any = await shopifyGql(
    `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { ... on MediaImage { id status } }
        mediaUserErrors { field message }
      }
    }`,
    {
      productId,
      media: [{ originalSource: target.resourceUrl, mediaContentType: "IMAGE", alt: file.fileName }],
    }
  );
  const errs2 = created.productCreateMedia.mediaUserErrors;
  if (errs2.length) throw new Error(`productCreateMedia: ${JSON.stringify(errs2)}`);
  return created.productCreateMedia.media[0].id;
}

async function deleteAllProductMedia(productId: string) {
  const data: any = await shopifyGql(
    `query($id: ID!) { product(id: $id) { media(first: 250) { edges { node { id } } } } }`,
    { id: productId }
  );
  const ids: string[] = (data.product?.media?.edges ?? []).map((e: any) => e.node.id);
  if (!ids.length) return;
  const res: any = await shopifyGql(
    `mutation($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        mediaUserErrors { field message }
      }
    }`,
    { productId, mediaIds: ids }
  );
  const errs = res.productDeleteMedia.mediaUserErrors;
  if (errs.length) throw new Error(`productDeleteMedia: ${JSON.stringify(errs)}`);
}

export const syncImagesToProduct = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      productId: string;
      mode: "add" | "replace";
      files: { fileId: string; fileName: string }[];
    }) =>
      z
        .object({
          productId: z.string().min(1),
          mode: z.enum(["add", "replace"]),
          files: z
            .array(z.object({ fileId: z.string().min(1), fileName: z.string().min(1) }))
            .min(1),
        })
        .parse(d)
  )
  .handler(async ({ data }) => {
    if (data.mode === "replace") {
      await deleteAllProductMedia(data.productId);
    }
    const mediaIds: string[] = [];
    for (const f of data.files) {
      mediaIds.push(await uploadOneToProduct(data.productId, f));
    }
    return { ok: true, mediaIds };
  });
