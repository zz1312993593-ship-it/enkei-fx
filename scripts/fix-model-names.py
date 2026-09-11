# -*- coding: utf-8 -*-
"""批6补充：模型/顾问名称按语言取值统一走 helper。幂等。import 由末尾正则统一更新。"""
import io
import re

def apply(path, subs):
    s = io.open(path, encoding='utf-8').read()
    done = 0
    for old, new in subs:
        if new in s:
            done += 1
            continue
        n = s.count(old)
        assert n >= 1, f'{path} missing: {old[:80]}'
        s = s.replace(old, new)
        done += n
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print(f'{path}: {done} replacements')

def add_catalog_names(path, names):
    s = io.open(path, encoding='utf-8').read()
    m = re.search(r"import \{ ([^}]*?) \} from '\.\./lib/model-catalog';", s)
    assert m, path
    current = set(x.strip() for x in m.group(1).split(',') if x.strip())
    wanted = current | set(names)
    if current == wanted:
        print(f'{path}: catalog import already ok')
        return
    s = s.replace(m.group(0), "import { " + ", ".join(sorted(wanted)) + " } from '../lib/model-catalog';")
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print(f'{path}: catalog import -> {", ".join(sorted(wanted))}')

apply('app/strategy-tournament.tsx', [
    ("<h4>{language === 'zh' ? definition.zh : definition.ja}</h4><p>{language === 'zh' ? definition.logicZh : definition.logicJa}</p>",
     "<h4>{modelName(definition, language)}</h4><p>{modelLogic(definition, language)}</p>"),
    ("{queue[0] ? `${language === 'zh' ? modelDefinition(queue[0].model).shortZh : modelDefinition(queue[0].model).shortJa} · ${t('本机保存', '端末内保存', 'Saved locally')}`",
     "{queue[0] ? `${modelShort(modelDefinition(queue[0].model), language)} · ${t('本机保存', '端末内保存', 'Saved locally')}`"),
])
add_catalog_names('app/strategy-tournament.tsx', ['modelLogic', 'modelName', 'modelShort'])

apply('app/model-lab.tsx', [
    ("{language === 'zh' ? item.zh : item.ja}</option>",
     "{advisorName(item, language)}</option>"),
    ("{language === 'zh' ? provider.roleZh : provider.roleJa} ·",
     "{advisorRole(provider, language)} ·"),
    ("{language === 'zh' ? advisorProvider(advisorPool.quickProvider).zh : advisorProvider(advisorPool.quickProvider).ja} → {language === 'zh' ? advisorProvider(advisorPool.deepProvider).zh : advisorProvider(advisorPool.deepProvider).ja} → {language === 'zh' ? advisorProvider(advisorPool.fallbackProvider).zh : advisorProvider(advisorPool.fallbackProvider).ja}",
     "{advisorName(advisorProvider(advisorPool.quickProvider), language)} → {advisorName(advisorProvider(advisorPool.deepProvider), language)} → {advisorName(advisorProvider(advisorPool.fallbackProvider), language)}"),
    ("<strong>{language === 'zh' ? selected.zh : selected.ja}</strong>",
     "<strong>{modelName(selected, language)}</strong>"),
    ("<h4>{language === 'zh' ? candidate.zh : candidate.ja}</h4>",
     "<h4>{modelName(candidate, language)}</h4>"),
    ("<p>{language === 'zh' ? candidate.logicZh : candidate.logicJa}</p>",
     "<p>{modelLogic(candidate, language)}</p>"),
    (": {language === 'zh' ? candidate.regimeZh : candidate.regimeJa}",
     ": {modelRegime(candidate, language)}"),
    ("{language === 'zh' ? modelDefinition(activations[0].model).shortZh : language === 'ja' ? modelDefinition(activations[0].model).shortJa : modelDefinition(activations[0].model).id}",
     "{modelShort(modelDefinition(activations[0].model), language)}"),
])
add_catalog_names('app/model-lab.tsx', ['modelLogic', 'modelName', 'modelRegime', 'modelShort'])
s = io.open('app/model-lab.tsx', encoding='utf-8').read()
m = re.search(r"import \{ ([^}]*?) \} from '\.\./lib/model-adapter';", s)
assert m, 'model-lab adapter import'
current = set(x.strip() for x in m.group(1).split(',') if x.strip())
wanted = (current | {'advisorName', 'advisorRole'}) - {'advisorProvider'} if False else current | {'advisorName', 'advisorRole'}
s = s.replace(m.group(0), "import { " + ", ".join(sorted(wanted)) + " } from '../lib/model-adapter';")
io.open('app/model-lab.tsx', 'w', encoding='utf-8', newline='').write(s)
print('app/model-lab.tsx: adapter import ->', ", ".join(sorted(wanted)))

apply('app/adaptive-research.tsx', [
    ("{language === 'zh' ? modelDefinition(activeModel).zh : language === 'ja' ? modelDefinition(activeModel).ja : modelDefinition(activeModel).id}",
     "{modelName(modelDefinition(activeModel), language)}"),
    ("{language === 'zh' ? selected.zh : language === 'ja' ? selected.ja : selected.id}",
     "{modelName(selected, language)}"),
    ("{leader ? (language === 'zh' ? leader.shortZh : language === 'ja' ? leader.shortJa : leader.id) : '—'}",
     "{leader ? modelShort(leader, language) : '—'}"),
])
add_catalog_names('app/adaptive-research.tsx', ['modelName', 'modelShort'])

apply('app/forward-validation.tsx', [
    ("{language === 'zh' ? modelDefinition(candidate.model).zh : language === 'ja' ? modelDefinition(candidate.model).ja : candidate.model}",
     "{modelName(modelDefinition(candidate.model), language)}"),
    ("{language === 'zh' ? modelDefinition(item.model).zh : modelDefinition(item.model).ja}",
     "{modelName(modelDefinition(item.model), language)}"),
])
add_catalog_names('app/forward-validation.tsx', ['modelName'])

apply('app/dashboard.tsx', [
    ("const modelLabel = language === 'zh' ? activeModelDefinition.zh : language === 'ja' ? activeModelDefinition.ja : activeModelDefinition.id;",
     "const modelLabel = modelName(activeModelDefinition, language);"),
    ("{language === 'zh' ? `查看：${item.zh}` : language === 'ja' ? `閲覧：${item.ja}` : `View: ${item.id}`}",
     "{language === 'zh' ? `查看：${item.zh}` : language === 'ja' ? `閲覧：${item.ja}` : `View: ${item.en}`}"),
])
add_catalog_names('app/dashboard.tsx', ['modelName'])

apply('app/demo-automation-panel.tsx', [
    ("<b>{language === 'zh' ? activeModel.zh : language === 'ja' ? activeModel.ja : activeModel.id}</b><small>{activeModel.id} / v{activeModel.version}</small>",
     "<b>{modelName(activeModel, language)}</b><small>{activeModel.id} / v{activeModel.version}</small>"),
    ("<small>{language === 'zh' ? activeModel.logicZh : language === 'ja' ? activeModel.logicJa : activeModel.id} ·",
     "<small>{modelLogic(activeModel, language)} ·"),
    ("<b>{language === 'zh' ? activeModel.zh : language === 'ja' ? activeModel.ja : activeModel.id}</b><small>{t('其他页面的手动查看不会改动这里。', '他画面の手動閲覧はここを変更しません。', 'Manual viewing on other pages does not change this model.')}</small>",
     "<b>{modelName(activeModel, language)}</b><small>{t('其他页面的手动查看不会改动这里。', '他画面の手動閲覧はここを変更しません。', 'Manual viewing on other pages does not change this model.')}</small>"),
])
add_catalog_names('app/demo-automation-panel.tsx', ['modelLogic', 'modelName'])
