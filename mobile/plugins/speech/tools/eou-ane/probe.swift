import CoreML
import Foundation

func now() -> Double { Date().timeIntervalSince1970 }
func unitsFrom(_ s: String) -> MLComputeUnits {
    switch s { case "ane": return .cpuAndNeuralEngine; case "gpu": return .cpuAndGPU; case "cpu": return .cpuOnly; default: return .all }
}
func dummyInputs(_ model: MLModel, seed: UInt64 = 1) throws -> MLDictionaryFeatureProvider {
    var rng = SeededRNG(seed: seed)
    var d: [String: MLFeatureValue] = [:]
    for (name, desc) in model.modelDescription.inputDescriptionsByName {
        guard let c = desc.multiArrayConstraint else { continue }
        let a = try MLMultiArray(shape: c.shape, dataType: c.dataType)
        let n = a.count
        let isLen = name.contains("length") || name.hasSuffix("_len")
        let isCache = name.contains("cache") && !isLen
        for i in 0..<n {
            switch c.dataType {
            case .int32: a[i] = NSNumber(value: isLen ? (name == "audio_length" ? (c.shape.count == 1 ? 64 : 1) : 0) : 1)
            case .float32, .float16, .double:
                if name == "mask" { a[i] = 1 } else if isCache { a[i] = 0 } else { a[i] = NSNumber(value: Float.random(in: -1...1, using: &rng) * 0.5) }
            default: break
            }
        }
        d[name] = MLFeatureValue(multiArray: a)
    }
    return try MLDictionaryFeatureProvider(dictionary: d)
}
struct SeededRNG: RandomNumberGenerator { var seed: UInt64
    mutating func next() -> UInt64 { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return seed } }

let args = CommandLine.arguments
guard args.count >= 4 else { print("usage: probe <mlmodelc> <ane|gpu|cpu|all> <load|plan|predict|dump OUT.json> [loads]"); exit(2) }
let url = URL(fileURLWithPath: args[1])
let cfg = MLModelConfiguration(); cfg.computeUnits = unitsFrom(args[2])
let mode = args[3]

if mode == "load" || mode == "predict" || mode == "dump" {
    let n = args.count > 5 ? Int(args[5])! : (mode == "load" ? 2 : 1)
    var model: MLModel!
    for i in 0..<n {
        let t = now()
        model = try MLModel(contentsOf: url, configuration: cfg)
        print(String(format: "load#%d %@ %@: %.2fs", i + 1, url.lastPathComponent, args[2], now() - t))
    }
    if mode != "load" {
        let inp = try dummyInputs(model)
        for i in 0..<3 {
            let t = now()
            let out = try model.prediction(from: inp)
            print(String(format: "predict#%d: %.1f ms", i + 1, (now() - t) * 1000))
            if i == 0 && mode == "dump" {
                var j: [String: [Double]] = [:]
                for name in out.featureNames { if let a = out.featureValue(for: name)?.multiArrayValue { j[name] = (0..<a.count).map { a[$0].doubleValue } } }
                try JSONSerialization.data(withJSONObject: j).write(to: URL(fileURLWithPath: args[4]))
            }
        }
        // timing loop
        var best = 1e9, tot = 0.0
        for _ in 0..<30 { let t = now(); _ = try model.prediction(from: inp); let e = now() - t; best = min(best, e); tot += e }
        print(String(format: "predict steady: best %.1f ms mean %.1f ms", best * 1000, tot / 30 * 1000))
    }
}
if mode == "plan" {
    let sem = DispatchSemaphore(value: 0)
    Task {
        do {
            let t = now()
            let plan = try await MLComputePlan.load(contentsOf: url, configuration: cfg)
            print(String(format: "plan load %.2fs", now() - t))
            guard case let .program(prog) = plan.modelStructure else { print("not a program"); sem.signal(); return }
            var counts: [String: Int] = [:]; var cost: [String: Double] = [:]
            var unsupported: [String: Int] = [:]
            func walk(_ block: MLModelStructure.Program.Block, _ fn: String) {
                for op in block.operations {
                    let usage = plan.deviceUsage(for: op)
                    let c = plan.estimatedCost(of: op)?.weight ?? 0
                    var label = "none"
                    if let u = usage {
                        switch u.preferred {
                        case .neuralEngine: label = "ANE"
                        case .gpu: label = "GPU"
                        case .cpu: label = "CPU"
                        @unknown default: label = "?"
                        }
                        let supported = u.supported.map { d -> String in switch d { case .neuralEngine: return "ANE"; case .gpu: return "GPU"; case .cpu: return "CPU"; @unknown default: return "?" } }
                        if !supported.contains("ANE") && op.operatorName != "const" { unsupported[op.operatorName, default: 0] += 1 }
                    }
                    if op.operatorName == "const" { continue }
                    counts[label, default: 0] += 1; cost[label, default: 0] += c
                    for b in op.blocks { walk(b, fn) }
                }
            }
            for (name, fn) in prog.functions { print("function", name); walk(fn.block, name) }
            let total = cost.values.reduce(0, +)
            for k in counts.keys.sorted() { print(String(format: "  %@: %d ops, cost weight %.3f (%.1f%%)", k, counts[k]!, cost[k]!, total > 0 ? cost[k]! / total * 100 : 0)) }
            print("  ops with ANE unsupported (op: count):", unsupported.sorted { $0.value > $1.value }.map { "\($0.key)=\($0.value)" }.joined(separator: ", "))
        } catch { print("plan error:", error) }
        sem.signal()
    }
    sem.wait()
}
