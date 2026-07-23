import React, { useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useAuthContext } from "@/contexts/AuthContext";
import Colors from "@/constants/colors";

export default function PlanScreen() {
  const insets = useSafeAreaInsets();
  const { activatePlan } = useAuthContext();

  const [token, setToken]       = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError]       = useState("");
  const [success, setSuccess]   = useState(false);

  const successScale = useRef(new Animated.Value(0)).current;
  const shakeAnim    = useRef(new Animated.Value(0)).current;

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const handleActivate = async () => {
    if (!token.trim()) { setError("Entrez votre token SXB-DATA-XXXX"); shake(); return; }
    setError(""); setIsLoading(true);
    try {
      await activatePlan(token.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSuccess(true);
      Animated.spring(successScale, { toValue: 1, tension: 80, friction: 6, useNativeDriver: true }).start();
      setTimeout(() => router.replace("/(tabs)/"), 1600);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      shake();
      const status = err?.response?.status;
      if (status === 404) setError("Token introuvable. Vérifiez le code.");
      else if (status === 409) setError("Token déjà utilisé.");
      else if (status === 403) setError("Token expiré.");
      else setError("Erreur réseau. Réessayez.");
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <Animated.View style={[{ alignItems: "center", gap: 16 }, { transform: [{ scale: successScale }] }]}>
          <View style={[styles.iconCircle, { backgroundColor: Colors.connectedDim, borderColor: Colors.connected + "40" }]}>
            <Ionicons name="checkmark-circle" size={72} color={Colors.connected} />
          </View>
          <Text style={{ fontSize: 26, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" }}>Forfait activé !</Text>
          <Text style={{ fontSize: 14, color: Colors.textSecondary, fontFamily: "Inter_400Regular" }}>Vos données ont été ajoutées</Text>
        </Animated.View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Back */}
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.textSecondary} />
        </Pressable>

        {/* Icon */}
        <View style={{ alignItems: "center", paddingVertical: 16 }}>
          <View style={[styles.iconCircle, { backgroundColor: Colors.purpleDim, borderColor: Colors.purple + "40" }]}>
            <Ionicons name="gift" size={52} color={Colors.purple} />
          </View>
        </View>

        <Text style={styles.title}>Activer un forfait</Text>
        <Text style={styles.subtitle}>
          Entrez votre token data pour ajouter du trafic à votre compte
        </Text>

        {/* Input */}
        <Animated.View style={{ transform: [{ translateX: shakeAnim }] }}>
          <TextInput
            style={[styles.input, error && { borderColor: Colors.disconnected }]}
            placeholder="SXB-DATA-XXXX-XXXX-XXXX"
            placeholderTextColor={Colors.textMuted}
            value={token}
            onChangeText={(t) => { setToken(t.toUpperCase()); setError(""); }}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleActivate}
          />
        </Animated.View>

        {error ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name="alert-circle" size={14} color={Colors.disconnected} />
            <Text style={{ fontSize: 13, color: Colors.disconnected, fontFamily: "Inter_500Medium" }}>{error}</Text>
          </View>
        ) : null}

        {/* Activate button */}
        <Pressable onPress={handleActivate} disabled={isLoading} style={[styles.btn, isLoading && { opacity: 0.6 }]}>
          <LinearGradient colors={[Colors.purple, "#6D28D9"]} style={styles.btnGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
            {isLoading
              ? <Text style={styles.btnText}>Activation...</Text>
              : <>
                  <Ionicons name="gift" size={18} color="#FFF" />
                  <Text style={styles.btnText}>Activer le forfait</Text>
                </>
            }
          </LinearGradient>
        </Pressable>

        {/* Info card */}
        <View style={styles.infoCard}>
          <Ionicons name="information-circle-outline" size={18} color={Colors.primary} />
          <Text style={styles.infoText}>
            Le token data est fourni par votre administrateur ou revendeur. Format : SXB-DATA-XXXX-XXXX-XXXX
          </Text>
        </View>

        {/* Separator */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: Colors.border }} />
          <Text style={{ fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" }}>ou</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: Colors.border }} />
        </View>

        <Pressable style={styles.qrBtn}>
          <Ionicons name="qr-code-outline" size={20} color={Colors.textSecondary} />
          <Text style={styles.qrBtnText}>Scanner un QR Code</Text>
        </Pressable>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 24, gap: 14 },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  iconCircle: { width: 110, height: 110, borderRadius: 55, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 26, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold", textAlign: "center" },
  subtitle: { fontSize: 14, color: Colors.textSecondary, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 },
  input: { backgroundColor: Colors.bgInput, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 16, fontSize: 15, color: "#FFF", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textAlign: "center" },
  btn: { borderRadius: 16, overflow: "hidden" },
  btnGrad: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 16 },
  btnText: { fontSize: 16, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  infoCard: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: Colors.bgCard, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, padding: 14 },
  infoText: { flex: 1, fontSize: 12, color: Colors.textSecondary, fontFamily: "Inter_400Regular", lineHeight: 18 },
  qrBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard },
  qrBtnText: { fontSize: 14, color: Colors.textSecondary, fontFamily: "Inter_500Medium" },
});
