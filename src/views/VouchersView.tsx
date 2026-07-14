export default function VouchersView({ currentUserRole }: { currentUserRole: string }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-6">Vouchers</h1>
      <p className="text-gray-400">Gestion des vouchers ({currentUserRole})</p>
    </div>
  );
}
