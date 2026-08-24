import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { listCompletions } from "@/lib/app-progress/service";
import { progressRouteError } from "@/lib/app-progress/route-utils";

export async function GET(request: Request) {
  try { const auth=await authorizeProtectedAppApi(request,"progress.read"); const url=new URL(request.url);
    const limit=url.searchParams.has("limit")?Number(url.searchParams.get("limit")):50;
    if (!Number.isInteger(limit)) throw new Error("INVALID_LIMIT");
    return NextResponse.json(await listCompletions(auth,url.searchParams.get("cursor")??undefined,limit),
      {headers:{"Cache-Control":"no-store"}});
  } catch(error) { return progressRouteError(error); }
}

