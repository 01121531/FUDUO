import { WechatManagement, type WechatSettings, type WechatMember } from "@/components/wechat-management";
import { apiGet } from "@/lib/api";

export default async function WechatPage() {
  const [settings, members] = await Promise.all([
    apiGet<WechatSettings>("/settings/wechat"),
    apiGet<WechatMember[]>("/settings/members"),
  ]);
  return <WechatManagement initialSettings={settings} members={members.filter((member) => member.active)} />;
}
