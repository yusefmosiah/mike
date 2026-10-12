import Image from "next/image";
import { Globe } from "lucide-react";
import type { PanelDocumentType } from "./types";

/**
 * The icon for a source that is not a file in the project: a case, a piece
 * of legislation or a saved web page. Null for files, which show their type.
 */
export function SourceTypeIcon({ type }: { type: PanelDocumentType | undefined }) {
    if (type === "web") {
        return <Globe aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-gray-500" />;
    }
    if (type !== "case" && type !== "legislation") return null;
    return (
        <Image
            src={type === "case" ? "/icons/legal-sources/case-law.svg" : "/icons/legal-sources/legislation.svg"}
            alt=""
            aria-hidden="true"
            width={14}
            height={14}
            className="h-3.5 w-3.5 shrink-0 object-contain"
        />
    );
}
