export default function SupportView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-white">Support</h1>
        <p className="text-gray-400 text-sm mt-1">Tickets de support</p>
      </div>
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4 sm:p-6">
        <p className="text-gray-500">Aucun ticket de support</p>
      </div>
    </div>
  );
}
