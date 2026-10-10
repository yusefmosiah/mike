// Rebuild the catalog after adding unmodified publisher files to public/.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(
  new URL("../frontend/public/preset-templates/", import.meta.url),
);
const output = new URL(
  "../frontend/src/app/components/library/presetTemplates.json",
  import.meta.url,
);
const publishers = {
  "General Legal": {
    sourceUrl: "https://general.legal/library",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
  "Common Paper": {
    sourceUrl: "https://commonpaper.com/standards/",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  Bonterms: {
    sourceUrl: "https://bonterms.com/download-center/",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
};

// Bonterms licenses each file separately. Its standard terms are CC BY 4.0
// except the files below, as their own notices state (checked 2026-10-10).
// Check the notice of every Bonterms file added later and list exceptions here.
const CC0 = {
  license: "CC0 1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
};
const CC_BY_ND = {
  license: "CC BY-ND 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-nd/4.0/",
  licenseNote: "Share unmodified only: this license does not allow distributing edited copies.",
};
const fileLicenses = {
  "Bonterms/ai-addendum/Example Cover Page for Bonterms Standard AI Addendum.docx": CC0,
  "Bonterms/business-associate-agreement/Example-Cover-Page-Bonterms-BAA.docx": CC0,
  "Bonterms/climate-addendum/Example-Cover-Page-Bonterms-Climate-Addenedum.docx": CC0,
  "Bonterms/cloud-terms/Example-Cover-Page-for-Bonterms-Cloud-Terms.docx": CC0,
  "Bonterms/cloud-terms/Example-Order-for-Bonterms-Cloud-Terms.docx": CC0,
  "Bonterms/data-protection-addendum/Example-Cover-Page-for-Bonterms-DPA.docx": CC0,
  "Bonterms/mutual-nda/Example-Cover-Page-for-Bonterms-Mutual-NDA.docx": CC0,
  "Bonterms/one-way-nda/Example-Cover-Page-for-Bonterms-One-Way-NDA.docx": CC0,
  "Bonterms/professional-services-agreement/Example-Cover-Page-for-Bonterms-PSA.docx": CC0,
  "Bonterms/professional-services-agreement/Example-SOW-for-Bonterms-PSA.docx": CC0,
  "Bonterms/reseller-agreement-(for-marketplaces)/Example-Cover-Page-for-Bonterms-Reseller-Agreement-for-Marketplaces.docx": CC0,
  "Bonterms/service-level-agreement/Bonterms-Acceptable-Use-Policy-Example.docx": CC0,
  "Bonterms/service-level-agreement/Bonterms-Support-Policy-Example.docx": CC0,
  "Bonterms/software-license-terms/Example-Cover-Page-for-Bonterms-Software-License-Terms.docx": CC0,
  "Bonterms/end-user-agreement-(for-marketplaces)/Bonterms-Standard-End-User-Agreement-Version-1.0.pdf": CC_BY_ND,
  "Bonterms/online-cloud-terms/Bonterms-Standard-Online-Cloud-Terms-2025-05-29.pdf": CC_BY_ND,
  "Bonterms/reseller-agreement-(for-marketplaces)/Bonterms-Standard-Reseller-Agreement-for-Marketplaces-Version-1.0.pdf": CC_BY_ND,
};

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(root).map((path) => relative(root, path).split("\\").join("/"));
for (const listed of Object.keys(fileLicenses)) {
  if (!files.includes(listed)) throw new Error(`Licensed file missing: ${listed}`);
}

const catalog = walk(root)
  .sort()
  .map((path) => {
    const relativePath = relative(root, path).split("\\").join("/");
    const format = extname(path).slice(1);
    if (!["docx", "pdf", "md"].includes(format))
      throw new Error(`Unsupported preset: ${relativePath}`);
    const publisher = relativePath.includes("/")
      ? relativePath.split("/")[0]
      : "Collection notes";
    const source = publishers[publisher];
    if (!source && relativePath !== "README.md")
      throw new Error(`Unknown publisher: ${relativePath}`);
    const bytes = readFileSync(path);
    return {
      id: relativePath,
      filename: relativePath.split("/").at(-1),
      title:
        relativePath === "README.md"
          ? "About this collection"
          : relativePath
              .split("/")
              .at(-1)
              .replace(/\.[^.]+$/, "")
              .replace(/-/g, " "),
      publisher,
      group: dirname(relativePath) === "." ? "" : dirname(relativePath),
      format,
      licenseNote: "",
      ...source,
      ...fileLicenses[relativePath],
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Cataloged ${catalog.length} preset files.`);
