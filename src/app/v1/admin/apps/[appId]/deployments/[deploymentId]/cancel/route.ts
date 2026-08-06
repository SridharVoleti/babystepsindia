import { handleDeploymentMutation } from "@/lib/authorization/deployment-route";
export async function POST(request: Request, { params }: { params: { appId: string; deploymentId: string } }) {
  return handleDeploymentMutation(request, params, "deployment.cancel");
}
