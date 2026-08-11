/**
 * 产品首页：直接重定向到工作台
 */
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/workspace');
}
